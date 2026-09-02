import { z } from 'zod'
import type { GeoJsonPoint, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import {
  hexCellAtPoint,
  hexCellCenter,
  hexCellsForPolygon,
  hexCellId,
  hexCellResolution,
  hexResolution,
  type HexCellId,
} from '../../core/spatial/index.ts'
import { evolveSurface } from './conditions.ts'
import {
  atmosphereAt,
  frameAt,
  weatherInfluences,
  weatherInfluenceEllipsePolygon,
  type WeatherInfluenceEntry,
} from './influence.ts'
import {
  weatherSurfaceSchema,
  weatherPackDataSchema,
  type WeatherConfig,
  type WeatherSample,
  type WeatherSurface,
} from './model.ts'

export const weatherLimits = {
  maxCells: 20_000,
  maxInfluences: 64,
  maxProbes: 256,
  maxSamples: 512,
  maxVertices: 2048,
  maxAdvanceSeconds: 3600,
  maxCellSteps: 2_000_000,
} as const
const checkpointSchema = z
  .object({
    config: z.string(),
    at: z.string().datetime(),
    epoch: z.string().datetime(),
    revision: z.number().int().nonnegative(),
    background: weatherSurfaceSchema,
    cells: z.array(z.tuple([z.string(), weatherSurfaceSchema])).max(weatherLimits.maxCells),
  })
  .strict()
export interface WeatherField {
  readonly config: WeatherConfig
  at: IsoTimestamp
  readonly epoch: IsoTimestamp
  revision: number
  background: WeatherSurface
  cells: Map<HexCellId, WeatherSurface>
  influences: ReadonlyArray<WeatherInfluenceEntry>
  coverage: Map<string, ReadonlyArray<HexCellId>>
}
export const createWeatherField = (config: WeatherConfig, at: IsoTimestamp, restored?: unknown): WeatherField => {
  if (restored !== undefined && restored !== null) {
    const state = checkpointSchema.parse(restored)
    if (Date.parse(state.at) < Date.parse(state.epoch)) throw new Error('Weather checkpoint precedes its epoch')
    if (state.config !== JSON.stringify(config)) throw new Error('Weather checkpoint configuration mismatch')
    const cells = new Map(
      state.cells.map(([id, surface]) => {
        const cell = hexCellId(id)
        if (hexCellResolution(cell) !== config.gridResolution) throw new Error('Weather checkpoint resolution mismatch')
        return [cell, surface] as const
      }),
    )
    if (cells.size !== state.cells.length) throw new Error('Duplicate Weather checkpoint cells')
    return {
      config,
      at: state.at as IsoTimestamp,
      epoch: state.epoch as IsoTimestamp,
      revision: state.revision,
      background: state.background,
      cells,
      influences: [],
      coverage: new Map(),
    }
  }
  return {
    config,
    at,
    epoch: at,
    revision: 0,
    background: structuredClone(config.surface),
    cells: new Map(),
    influences: [],
    coverage: new Map(),
  }
}
export const checkpointWeatherField = (field: WeatherField): unknown => ({
  config: JSON.stringify(field.config),
  at: field.at,
  epoch: field.epoch,
  revision: field.revision,
  background: field.background,
  cells: [...field.cells],
})
export const coverageFor = (
  field: WeatherField,
  entry: WeatherInfluenceEntry,
  at: string,
): ReadonlyArray<HexCellId> => {
  const area = frameAt(entry, at)
  const key = JSON.stringify([area.center, area.semiMajorAxisM, area.semiMinorAxisM, area.rotationDeg])
  const cached = field.coverage.get(key)
  if (cached) return cached
  const cells = hexCellsForPolygon(
    weatherInfluenceEllipsePolygon(area),
    hexResolution(field.config.gridResolution),
    weatherLimits.maxCells,
  )
  // A ground cell represents its center. Tiny influences still affect precise atmospheric samples;
  // ground below the chosen mesh scale is explicitly unresolved, never silently enlarged.
  let cachedCells = [...field.coverage.values()].reduce((sum, values) => sum + values.length, 0)
  while (field.coverage.size >= 128 || cachedCells + cells.length > weatherLimits.maxCells * 2) {
    const oldest = field.coverage.keys().next().value
    if (oldest === undefined) break
    cachedCells -= field.coverage.get(oldest)!.length
    field.coverage.delete(oldest)
  }
  field.coverage.set(key, cells)
  return cells
}
export const setWeatherObjects = (field: WeatherField, objects: ReadonlyArray<OperationalObject>): void => {
  const probes = objects.filter(
    (object) =>
      object.packId === 'weather' && weatherPackDataSchema.parse(object.packData).definition.type === 'weather_probe',
  )
  if (probes.length > weatherLimits.maxProbes) throw new Error('Weather probe limit exceeded')
  const entries = weatherInfluences(objects)
  if (entries.length > weatherLimits.maxInfluences) throw new Error('Weather influence limit exceeded')
  const total = new Set<HexCellId>()
  for (const entry of entries) {
    // Preflight every authored geometry before accepting the edit.
    for (const at of [
      entry.startsAt,
      ...entry.area.keyframes.map((k) => new Date(Date.parse(entry.startsAt) + k.atSeconds * 1000).toISOString()),
    ]) {
      for (const id of coverageFor(field, entry, at)) total.add(id)
      if (total.size > weatherLimits.maxCells) throw new Error('Weather total cell budget exceeded')
    }
  }
  field.influences = entries
}
const evaluated = new WeakMap<
  WeatherField,
  { at: string; source: ReadonlyArray<WeatherInfluenceEntry>; entries: ReadonlyArray<WeatherInfluenceEntry> }
>()
const framesAt = (field: WeatherField, at: string): ReadonlyArray<WeatherInfluenceEntry> => {
  const cached = evaluated.get(field)
  if (cached?.at === at && cached.source === field.influences) return cached.entries
  const entries = field.influences.map((entry) => ({ ...entry, area: { ...frameAt(entry, at), keyframes: [] } }))
  evaluated.set(field, { at, source: field.influences, entries })
  return entries
}
export const sampleWeather = (field: WeatherField, point: GeoJsonPoint): WeatherSample => {
  const sampled = atmosphereAt(field.config.atmosphere, framesAt(field, field.at), point, field.at)
  const id = hexCellAtPoint(point, hexResolution(field.config.gridResolution))
  return {
    state: { atmosphere: sampled.atmosphere, surface: structuredClone(field.cells.get(id) ?? field.background) },
    quality: { provenance: 'scenario', validAt: field.at, model: 'prescribed-atmosphere/heuristic-ground' },
    activeInfluenceIds: sampled.activeInfluenceIds,
    resolution: field.config.gridResolution,
    fieldRevision: field.revision,
  }
}
export const validateWeatherAdvance = (field: WeatherField, target: IsoTimestamp): void => {
  const delta = (Date.parse(target) - Date.parse(field.at)) / 1000
  if (delta < 0) throw new Error('Weather cannot seek backward; reset or restore a checkpoint')
  if (delta > weatherLimits.maxAdvanceSeconds) throw new Error('Weather advance exceeds one-hour work budget')
}
export const advanceWeather = (field: WeatherField, target: IsoTimestamp): void => {
  validateWeatherAdvance(field, target)
  const delta = (Date.parse(target) - Date.parse(field.at)) / 1000
  // Stage the batch so a rejected work budget never leaves partially advanced ground state.
  const staged = { ...field, cells: new Map(field.cells) }
  advanceSteps(staged, Math.floor(delta))
  field.background = staged.background
  field.cells = staged.cells
  field.at = staged.at
  field.revision = staged.revision
}
const advanceSteps = (field: WeatherField, ticks: number): void => {
  let work = 0
  // Fixed one-second grid anchored at the checkpoint epoch; outer tick partition does not affect physics.
  for (let i = 0; i < ticks; i++) {
    const at = new Date(Date.parse(field.at) + 1000).toISOString() as IsoTimestamp
    const ids = new Set(field.cells.keys())
    for (const entry of field.influences) for (const id of coverageFor(field, entry, at)) ids.add(id)
    if (ids.size > weatherLimits.maxCells) throw new Error('Weather accumulated cell budget exceeded')
    work += Math.max(1, ids.size) * Math.max(1, field.influences.length)
    if (work > weatherLimits.maxCellSteps)
      throw new Error('Weather advance exceeds cell-step work budget; use smaller time increments')
    const background = evolveSurface({
      surface: field.background,
      atmosphere: field.config.atmosphere,
      at,
      elapsedSeconds: 1,
    })
    const cells = new Map<HexCellId, WeatherSurface>()
    const frames = framesAt(field, at)
    for (const id of ids) {
      const atmosphere = atmosphereAt(field.config.atmosphere, frames, hexCellCenter(id), at).atmosphere
      const next = evolveSurface({
        surface: field.cells.get(id) ?? field.background,
        atmosphere,
        at,
        elapsedSeconds: 1,
      })
      if (
        Object.keys(next).some(
          (k) => Math.abs(next[k as keyof WeatherSurface] - background[k as keyof WeatherSurface]) > 1e-6,
        )
      )
        cells.set(id, next)
    }
    field.background = background
    field.cells = cells
    field.at = at
    field.revision++
  }
}
export const interveneGround = (
  field: WeatherField,
  ids: ReadonlyArray<HexCellId>,
  patch: { [K in keyof WeatherSurface]?: WeatherSurface[K] | undefined },
): void => {
  if (new Set([...field.cells.keys(), ...ids]).size > weatherLimits.maxCells)
    throw new Error('Weather intervention exceeds cell budget')
  for (const id of ids)
    field.cells.set(id, weatherSurfaceSchema.parse({ ...(field.cells.get(id) ?? field.background), ...patch }))
  field.revision++
}
