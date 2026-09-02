import { z } from 'zod'
import {
  geoPointFromLonLat,
  geoJsonPointSchema,
  geoJsonLineStringSchema,
  geoJsonPolygonSchema,
  pointFromPosition,
  routeDistanceMeters,
  type GeoJsonPoint,
} from '../../core/model/index.ts'
import { hexCellsForPolygon, hexCellCenter, hexResolution } from '../../core/spatial/index.ts'
import { packMapAreaFeatureSchema } from '../../core/packs/protocol.ts'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { PackRuntimeQuery, SimulationCapability } from '../../simulation/protocol.ts'
import { weatherSampleSchema, weatherPackConfigSchema } from './model.ts'
import { sampleWeather, weatherLimits, type WeatherField } from './cell-field.ts'
import { projectWeatherFieldForMap } from './projection.ts'
import { weatherQuantities } from './quantities.ts'
import { weatherPresentationSeverityForState } from './conditions.ts'

const routeSchema = z
  .object({ route: geoJsonLineStringSchema, intervalM: z.number().finite().min(10).max(5000).default(500) })
  .strict()
const areaSchema = z.object({ area: geoJsonPolygonSchema }).strict()
const mapSchema = z
  .object({
    viewport: geoJsonPolygonSchema,
    zoom: z.number().min(0).max(24),
    layers: z
      .array(z.enum(['baseGrid', 'affectedCells', 'influenceShapes']))
      .max(3)
      .default(['affectedCells', 'influenceShapes']),
  })
  .strict()
const summarySchema = z
  .object({ sampleCount: z.number(), severityCounts: z.record(z.string(), z.number()), worstSeverity: z.string() })
  .strict()
const samplesSchema = z
  .array(z.object({ point: geoJsonPointSchema, sample: weatherSampleSchema }).strict())
  .max(weatherLimits.maxSamples)
const statsSchema = z
  .object({
    cellCount: z.number(),
    influenceCount: z.number(),
    truthResolution: z.number(),
    fieldRevision: z.number(),
    simulationTime: z.string(),
    model: z.string(),
  })
  .strict()
export const weatherQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  defineSimulationQueryCapability({
    id: 'world.weather.sample-at-point',
    title: 'Sample weather at point',
    description:
      'Current prescribed atmosphere and heuristic ground conditions. Returns simulation time, field revision and ground resolution; quantities use °C, m/s, degrees FROM north, m, mm/h and normalized ground fractions.',
    input: z.object({ point: geoJsonPointSchema }).strict(),
    output: weatherSampleSchema,
  }),
  defineSimulationQueryCapability({
    id: 'world.weather.sample-points',
    title: 'Sample weather at points',
    description: 'Up to 512 points from the same field revision. Read-only; never advances simulation.',
    input: z.object({ points: z.array(geoJsonPointSchema).max(512) }).strict(),
    output: samplesSchema,
  }),
  defineSimulationQueryCapability({
    id: 'world.weather.sample-along-route',
    title: 'Sample weather along route',
    description:
      'At most 512 samples including endpoints, spacing 10–5000 m, at most 2048 route vertices. Rejects excessive work; no silent coarsening.',
    input: routeSchema,
    output: z.object({ samples: samplesSchema, summary: summarySchema, intervalM: z.number() }).strict(),
  }),
  defineSimulationQueryCapability({
    id: 'world.weather.summarize-area',
    title: 'Summarize weather area',
    description:
      'Cell-center samples including background conditions, excluding polygon holes. Rejects polygons with no resolved cell centers or more than the 512-cell work budget.',
    input: areaSchema,
    output: z
      .object({ cellCount: z.number(), summary: summarySchema, resolution: z.number(), simulationTime: z.string() })
      .strict(),
  }),
  defineSimulationQueryCapability({
    id: 'world.weather.map-features',
    title: 'Read weather map features',
    description:
      'Bounded presentation of current conditions. Zoom changes display resolution, never physics. No historical or forecast truth is synthesized.',
    input: mapSchema,
    output: z.object({ features: z.array(packMapAreaFeatureSchema), metadata: statsSchema }).strict(),
  }),
  defineSimulationQueryCapability({
    id: 'world.weather.field-stats',
    title: 'Inspect weather field',
    description: 'Current field size, simulation time, revision and model fidelity.',
    input: z.object({}).strict(),
    output: statsSchema,
  }),
  defineSimulationQueryCapability({
    id: 'world.weather.describe',
    title: 'Describe weather model',
    description:
      'Configuration, units, supported controls and work limits. No live forecast feed, terrain hydrology or physical road-friction model.',
    input: z.object({}).strict(),
    output: z
      .object({
        config: weatherPackConfigSchema,
        limits: z.record(z.string(), z.number()),
        units: z.record(z.string(), z.string()),
        groundCoverage: z.string(),
      })
      .strict(),
  }),
]
const stats = (field: WeatherField) => ({
  cellCount: field.cells.size,
  influenceCount: field.influences.length,
  truthResolution: field.config.gridResolution,
  fieldRevision: field.revision,
  simulationTime: field.at,
  model: 'prescribed-atmosphere/heuristic-ground',
})
const mapCache = new WeakMap<WeatherField, { revision: number; results: Map<string, unknown> }>()
const summarize = (samples: ReadonlyArray<ReturnType<typeof sampleWeather>>) => {
  const severityCounts: Record<string, number> = { normal: 0, notice: 0, adverse: 0, hazard: 0 }
  for (const sample of samples) severityCounts[weatherPresentationSeverityForState(sample.state)]!++
  return {
    sampleCount: samples.length,
    severityCounts,
    worstSeverity: ['hazard', 'adverse', 'notice', 'normal'].find((s) => severityCounts[s]! > 0) ?? 'normal',
  }
}
export const answerWeatherQuery = (field: WeatherField, request: PackRuntimeQuery): unknown => {
  const input = weatherQueryCapabilities.find((c) => c.id === request.capabilityId)?.input.parse(request.input)
  if (!input) throw new Error('Unknown Weather query: ' + request.capabilityId)
  if (request.capabilityId === 'world.weather.sample-at-point')
    return sampleWeather(field, (input as { point: GeoJsonPoint }).point)
  if (request.capabilityId === 'world.weather.sample-points')
    return (input as { points: GeoJsonPoint[] }).points.map((point) => ({ point, sample: sampleWeather(field, point) }))
  if (request.capabilityId === 'world.weather.field-stats') return stats(field)
  if (request.capabilityId === 'world.weather.describe')
    return {
      config: field.config,
      limits: weatherLimits,
      units: Object.fromEntries(weatherQuantities.map((quantity) => [quantity.id, quantity.unit])),
      groundCoverage:
        'Ground uses cell-center forcing; influences below the ground mesh scale remain atmospherically effective but ground detail is unresolved.',
    }
  if (request.capabilityId === 'world.weather.map-features') {
    const p = mapSchema.parse(input),
      key = JSON.stringify(p)
    let cache = mapCache.get(field)
    if (cache?.revision !== field.revision) {
      cache = { revision: field.revision, results: new Map() }
      mapCache.set(field, cache)
    }
    const cached = cache.results.get(key)
    if (cached) return cached
    const result = { features: projectWeatherFieldForMap(field, p.viewport, p.zoom, p.layers), metadata: stats(field) }
    if (cache.results.size >= 4) cache.results.delete(cache.results.keys().next().value!)
    cache.results.set(key, result)
    return result
  }
  if (request.capabilityId === 'world.weather.summarize-area') {
    const ids = hexCellsForPolygon(areaSchema.parse(input).area, hexResolution(field.config.gridResolution), 512)
    if (!ids.length) throw new Error('Area has no resolved ground cell centers; enlarge area or use point sampling')
    return {
      cellCount: ids.length,
      summary: summarize(ids.map((id) => sampleWeather(field, hexCellCenter(id)))),
      resolution: field.config.gridResolution,
      simulationTime: field.at,
    }
  }
  const { route, intervalM } = routeSchema.parse(input)
  if (route.coordinates.length > weatherLimits.maxVertices) throw new Error('Route exceeds vertex budget')
  const lengths = route.coordinates
    .slice(1)
    .map((p, i) => routeDistanceMeters(pointFromPosition(route.coordinates[i]!), pointFromPosition(p)))
  const total = lengths.reduce((a, b) => a + b, 0)
  if (Math.ceil(total / intervalM) + 2 > weatherLimits.maxSamples)
    throw new Error('Route exceeds 512 sample budget; increase spacing or shorten route')
  const points: GeoJsonPoint[] = [pointFromPosition(route.coordinates[0]!)]
  let along = intervalM,
    offset = 0
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!,
      a = route.coordinates[i]!,
      b = route.coordinates[i + 1]!
    while (along < offset + length) {
      const t = (along - offset) / length
      points.push(geoPointFromLonLat(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
      along += intervalM
    }
    offset += length
  }
  points.push(pointFromPosition(route.coordinates.at(-1)!))
  const samples = points.map((point) => ({ point, sample: sampleWeather(field, point) }))
  return { samples, summary: summarize(samples.map((s) => s.sample)), intervalM }
}
