import type { GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import {
  hexCellAtPoint,
  hexCellBoundary,
  hexCellCenter,
  hexCellsForPolygon,
  hexResolution,
  type HexCellId,
  type HexResolution,
} from '../../core/spatial/index.ts'
import {
  evolveSurfaceWithResidual,
  surfaceIsDefaultLike,
} from './conditions.ts'
import { defaultAtmosphere, defaultSurface } from './defaults.ts'
import {
  activeWeatherInfluencesAt,
  mixWeatherState,
  weatherInfluenceEllipsePolygon,
  weatherInfluenceWeightForPoint,
  type WeatherInfluenceEntry,
} from './influence.ts'
import {
  type WeatherSample,
  type WeatherState,
  weatherDomainDataSchema,
} from './model.ts'

const minimumStoredResidual = 0.005

export type WeatherCellId = HexCellId

export interface WeatherGridDefinition {
  readonly gridId: string
  readonly truthResolution: HexResolution
}

export interface WeatherCellState {
  readonly id: WeatherCellId
  readonly resolution: HexResolution
  readonly center: GeoJsonPoint
  readonly state: WeatherState
  readonly activeInfluenceIds: ReadonlyArray<ObjectId>
  readonly residual: number
  readonly updatedAt: IsoTimestamp
}

export interface WeatherSparseField {
  readonly grid: WeatherGridDefinition
  readonly cells: ReadonlyMap<WeatherCellId, WeatherCellState>
  readonly activeCellIds: ReadonlySet<WeatherCellId>
}

export interface WeatherFieldUpdate {
  readonly field: WeatherSparseField
  readonly touchedCellIds: ReadonlySet<WeatherCellId>
  readonly deletedCellIds: ReadonlySet<WeatherCellId>
}

const defaultStateFor = (at: IsoTimestamp): WeatherState => ({
  atmosphere: defaultAtmosphere(at),
  surface: defaultSurface(),
  extensions: {},
})

const cellsUnderInfluences = (
  grid: WeatherGridDefinition,
  influences: ReadonlyArray<WeatherInfluenceEntry>,
): ReadonlyMap<WeatherCellId, GeoJsonPoint> => {
  const cells = new Map<WeatherCellId, GeoJsonPoint>()
  for (const influence of influences) {
    const polygon = weatherInfluenceEllipsePolygon(influence.frame)
    for (const id of hexCellsForPolygon(polygon, grid.truthResolution)) {
      const center = hexCellCenter(id)
      if (weatherInfluenceWeightForPoint(center, influence.frame) <= 0) continue
      cells.set(id, center)
    }
  }
  return cells
}

const solveForcedState = (config: {
  readonly base: WeatherState
  readonly center: GeoJsonPoint
  readonly influences: ReadonlyArray<WeatherInfluenceEntry>
}): { readonly state: WeatherState; readonly activeInfluenceIds: ReadonlyArray<ObjectId> } => {
  let state = config.base
  const activeInfluenceIds: ObjectId[] = []
  for (const influence of config.influences) {
    const weight = weatherInfluenceWeightForPoint(config.center, influence.frame)
    if (weight <= 0) continue
    state = mixWeatherState(state, influence.frame.state, weight)
    activeInfluenceIds.push(influence.objectId)
  }
  return { state, activeInfluenceIds }
}

const cellStateFrom = (config: {
  readonly field: WeatherSparseField
  readonly id: WeatherCellId
  readonly center: GeoJsonPoint
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
  readonly influences: ReadonlyArray<WeatherInfluenceEntry>
}): WeatherCellState | null => {
  const previous = config.field.cells.get(config.id)
  const defaultState = defaultStateFor(config.at)
  const base = {
    atmosphere: defaultState.atmosphere,
    surface: previous?.state.surface ?? defaultState.surface,
    extensions: previous?.state.extensions ?? defaultState.extensions,
  }
  const forced = solveForcedState({
    base,
    center: config.center,
    influences: config.influences,
  })
  const evolved = evolveSurfaceWithResidual({
    surface: forced.state.surface,
    atmosphere: forced.state.atmosphere,
    at: config.at,
    elapsedSeconds: config.elapsedSeconds,
    defaultSurface: defaultState.surface,
  })
  if (forced.activeInfluenceIds.length === 0 && evolved.defaultLike) return null
  return {
    id: config.id,
    resolution: config.field.grid.truthResolution,
    center: config.center,
    state: {
      atmosphere: forced.state.atmosphere,
      surface: evolved.surface,
      extensions: forced.state.extensions,
    },
    activeInfluenceIds: forced.activeInfluenceIds,
    residual: evolved.residual,
    updatedAt: config.at,
  }
}

export const createWeatherSparseField = (grid: WeatherGridDefinition): WeatherSparseField => ({
  grid,
  cells: new Map(),
  activeCellIds: new Set(),
})

export const weatherGridForObjects = (config: {
  readonly gridId: string
  readonly objects: ReadonlyArray<OperationalObject>
  readonly fallbackPoint: GeoJsonPoint
  readonly fallbackResolution?: number
}): WeatherGridDefinition => {
  const resolutions = config.objects.flatMap(object => {
    const parsed = weatherDomainDataSchema.safeParse(object.domainData)
    return parsed.success && parsed.data.render?.truthResolution ? [parsed.data.render.truthResolution] : []
  })
  return {
    gridId: config.gridId,
    truthResolution: hexResolution(resolutions.length > 0 ? Math.max(...resolutions) : config.fallbackResolution ?? 8),
  }
}

export const updateWeatherSparseField = (config: {
  readonly field: WeatherSparseField
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
  readonly elapsedSeconds: number
}): WeatherFieldUpdate => {
  const influences = activeWeatherInfluencesAt(config.objects, config.at)
  const forcedCells = cellsUnderInfluences(config.field.grid, influences)
  const candidateIds = new Set<WeatherCellId>([
    ...forcedCells.keys(),
    ...config.field.activeCellIds,
  ])
  const cells = new Map(config.field.cells)
  const activeCellIds = new Set<WeatherCellId>()
  const touchedCellIds = new Set<WeatherCellId>()
  const deletedCellIds = new Set<WeatherCellId>()

  for (const id of candidateIds) {
    const center = forcedCells.get(id) ?? cells.get(id)?.center ?? hexCellCenter(id)
    const next = cellStateFrom({
      field: { ...config.field, cells },
      id,
      center,
      at: config.at,
      elapsedSeconds: config.elapsedSeconds,
      influences,
    })
    touchedCellIds.add(id)
    if (!next) {
      if (cells.delete(id)) deletedCellIds.add(id)
      continue
    }
    cells.set(id, next)
    if (next.residual > minimumStoredResidual) activeCellIds.add(id)
  }

  return {
    field: {
      grid: config.field.grid,
      cells,
      activeCellIds,
    },
    touchedCellIds,
    deletedCellIds,
  }
}

export const weatherCellForPoint = (
  grid: WeatherGridDefinition,
  point: GeoJsonPoint,
): WeatherCellId => hexCellAtPoint(point, grid.truthResolution)

export const weatherCellId = (
  _grid: WeatherGridDefinition,
  cell: WeatherCellId,
): WeatherCellId => cell

export const weatherCellPolygon = (cellId: WeatherCellId): GeoJsonPolygon =>
  hexCellBoundary(cellId)

export const weatherSampleAtPointFromSparseField = (config: {
  readonly field: WeatherSparseField
  readonly point: GeoJsonPoint
  readonly at: IsoTimestamp
}): WeatherSample => {
  const id = weatherCellForPoint(config.field.grid, config.point)
  const existing = config.field.cells.get(id)
  if (!existing) {
    const state = defaultStateFor(config.at)
    return {
      state,
      quality: { provenance: 'scenario', confidence: 0.6, validAt: config.at },
      activeInfluenceIds: [],
    }
  }
  return {
    state: existing.state,
    quality: {
      provenance: existing.activeInfluenceIds.length > 0 ? 'inferred' : 'scenario',
      confidence: existing.activeInfluenceIds.length > 0 ? 0.85 : 0.7,
      validAt: existing.updatedAt,
    },
    activeInfluenceIds: existing.activeInfluenceIds,
  }
}

export const weatherSparseFieldStats = (field: WeatherSparseField): {
  readonly cellCount: number
  readonly activeCellCount: number
} => ({
  cellCount: field.cells.size,
  activeCellCount: field.activeCellIds.size,
})
