import { z } from 'zod'
import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { geoJsonLineStringSchema, geoJsonPointSchema, geoJsonPolygonSchema, pointFromPosition, routeDistanceMeters } from '../../core/model/index.ts'
import { packMapAreaFeatureSchema } from '../../core/packs/protocol.ts'
import type { PackRuntimeQuery, SimulationCapability } from '../../simulation/protocol.ts'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { WeatherSparseField } from './cell-field.ts'
import { weatherSampleAtPointFromSparseField, weatherSparseFieldStats } from './cell-field.ts'
import { weatherPresentationSeverityForState } from './conditions.ts'
import { projectWeatherFieldForMap } from './projection.ts'
import { weatherSampleSchema } from './model.ts'

const weatherPointQuerySchema = z.object({
  point: geoJsonPointSchema,
}).strict()

const weatherRouteQuerySchema = z.object({
  route: geoJsonLineStringSchema,
  intervalM: z.number().finite().positive().max(5000).default(500),
}).strict()

const weatherAreaQuerySchema = z.object({
  area: geoJsonPolygonSchema,
}).strict()

const weatherMapFeaturesQuerySchema = z.object({
  viewport: geoJsonPolygonSchema,
  zoom: z.number().finite().min(0).max(24),
  at: z.string().datetime().optional(),
  animationDurationMs: z.number().finite().positive().max(10_000).optional(),
  layers: z.array(z.enum(['baseGrid', 'affectedCells', 'influenceShapes'])).default(['baseGrid', 'affectedCells', 'influenceShapes']),
}).strict()

export const weatherQueryKinds = [
  'world.weather.sample-at-point',
  'world.weather.sample-along-route',
  'world.weather.summarize-area',
  'world.weather.map-features',
  'world.weather.field-stats',
] as const

const weatherSummarySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  severityCounts: z.record(z.string(), z.number().int().nonnegative()),
  worstSeverity: z.string().min(1),
}).strict()
const weatherFieldStatsSchema = z.object({
  cellCount: z.number().int().nonnegative(),
  activeCellCount: z.number().int().nonnegative(),
  truthResolution: z.number().int().nonnegative(),
}).strict()

export const weatherQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  defineSimulationQueryCapability({ id: weatherQueryKinds[0], title: 'Sample weather at point', description: 'Returns current atmospheric and surface conditions at a geographic point.', input: weatherPointQuerySchema, output: weatherSampleSchema }),
  defineSimulationQueryCapability({ id: weatherQueryKinds[1], title: 'Sample weather along route', description: 'Returns bounded weather samples and a severity summary along a route.', input: weatherRouteQuerySchema, output: z.object({ samples: z.array(z.object({ point: geoJsonPointSchema, sample: weatherSampleSchema }).strict()), summary: weatherSummarySchema }).strict() }),
  defineSimulationQueryCapability({ id: weatherQueryKinds[2], title: 'Summarize weather area', description: 'Summarizes current weather severity across cells inside a polygon.', input: weatherAreaQuerySchema, output: z.object({ cellCount: z.number().int().nonnegative(), summary: weatherSummarySchema }).strict() }),
  defineSimulationQueryCapability({ id: weatherQueryKinds[3], title: 'Read weather map features', description: 'Projects current weather truth into bounded map features for a viewport.', input: weatherMapFeaturesQuerySchema, output: z.object({ features: z.array(packMapAreaFeatureSchema), metadata: weatherFieldStatsSchema }).strict() }),
  defineSimulationQueryCapability({ id: weatherQueryKinds[4], title: 'Read weather field statistics', description: 'Returns current sparse weather-field size and truth resolution.', input: z.object({}).strict(), output: weatherFieldStatsSchema }),
]

const failure = (reason: string): never => { throw new Error(reason) }

const interpolatePoint = (
  from: GeoJsonPoint,
  to: GeoJsonPoint,
  ratio: number,
): GeoJsonPoint => ({
  type: 'Point',
  coordinates: [
    (from.coordinates[0] + (to.coordinates[0] - from.coordinates[0]) * ratio) as GeoJsonPoint['coordinates'][0],
    (from.coordinates[1] + (to.coordinates[1] - from.coordinates[1]) * ratio) as GeoJsonPoint['coordinates'][1],
  ],
})

const samplePointsAlongRoute = (
  route: GeoJsonLineString,
  intervalM: number,
): ReadonlyArray<GeoJsonPoint> => {
  const points: GeoJsonPoint[] = []
  let distanceSinceSample = 0
  for (let index = 0; index < route.coordinates.length - 1; index += 1) {
    const from = pointFromPosition(route.coordinates[index]!)
    const to = pointFromPosition(route.coordinates[index + 1]!)
    const segmentDistance = routeDistanceMeters(from, to)
    if (index === 0) points.push(from)
    if (segmentDistance <= 0) continue
    let nextSampleDistance = intervalM - distanceSinceSample
    while (nextSampleDistance < segmentDistance) {
      points.push(interpolatePoint(from, to, nextSampleDistance / segmentDistance))
      nextSampleDistance += intervalM
    }
    distanceSinceSample = (distanceSinceSample + segmentDistance) % intervalM
  }
  const last = route.coordinates.at(-1)
  if (last) points.push(pointFromPosition(last))
  return points
}

const pointInPolygon = (
  point: GeoJsonPoint,
  polygon: GeoJsonPolygon,
): boolean => {
  const ring = polygon.coordinates[0]
  if (!ring) return false
  const [x, y] = point.coordinates
  let inside = false
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index++) {
    const [xi, yi] = ring[index] ?? [0, 0]
    const [xj, yj] = ring[previousIndex] ?? [0, 0]
    const intersects = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

const summarizeSamples = (
  samples: ReadonlyArray<ReturnType<typeof weatherSampleAtPointFromSparseField>>,
): {
  readonly sampleCount: number
  readonly severityCounts: Record<string, number>
  readonly worstSeverity: string
} => {
  const severityCounts: Record<string, number> = {}
  let worstSeverity = 'normal'
  const severityScore = { normal: 0, notice: 1, adverse: 2, hazard: 3 } as const
  for (const sample of samples) {
    const severity = weatherPresentationSeverityForState(sample.state)
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1
    if (severityScore[severity] > severityScore[worstSeverity as keyof typeof severityScore]) worstSeverity = severity
  }
  return { sampleCount: samples.length, severityCounts, worstSeverity }
}

export const answerWeatherQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly field: WeatherSparseField
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
}): unknown => {
  try {
    if (config.request.capabilityId === weatherQueryKinds[0]) {
      const payload = weatherPointQuerySchema.parse(config.request.input)
      return weatherSampleAtPointFromSparseField({
        field: config.field,
        point: payload.point,
        at: config.at,
      })
    }
    if (config.request.capabilityId === weatherQueryKinds[1]) {
      const payload = weatherRouteQuerySchema.parse(config.request.input)
      const points = samplePointsAlongRoute(payload.route, payload.intervalM)
      const samples = points.map(point => ({
        point,
        sample: weatherSampleAtPointFromSparseField({ field: config.field, point, at: config.at }),
      }))
      return {
        samples,
        summary: summarizeSamples(samples.map(item => item.sample)),
      }
    }
    if (config.request.capabilityId === weatherQueryKinds[2]) {
      const payload = weatherAreaQuerySchema.parse(config.request.input)
      const cells = [...config.field.cells.values()].filter(cell => pointInPolygon(cell.center, payload.area))
      return {
        cellCount: cells.length,
        summary: summarizeSamples(cells.map(cell => ({
          state: cell.state,
          quality: { provenance: cell.activeInfluenceIds.length > 0 ? 'inferred' : 'scenario', confidence: 0.7, validAt: cell.updatedAt },
          activeInfluenceIds: cell.activeInfluenceIds,
        }))),
      }
    }
    if (config.request.capabilityId === weatherQueryKinds[3]) {
      const payload = weatherMapFeaturesQuerySchema.parse(config.request.input)
      const at = (payload.at ?? config.at) as IsoTimestamp
      const features = projectWeatherFieldForMap({
        field: config.field,
        objects: config.objects,
        viewport: payload.viewport,
        zoom: payload.zoom,
        at,
        layers: payload.layers,
        ...(payload.animationDurationMs === undefined ? {} : { animationDurationMs: payload.animationDurationMs }),
      })
      return {
        features,
        metadata: {
          ...weatherSparseFieldStats(config.field),
          truthResolution: config.field.grid.truthResolution,
        },
      }
    }
    if (config.request.capabilityId === weatherQueryKinds[4]) {
      return {
        ...weatherSparseFieldStats(config.field),
        truthResolution: config.field.grid.truthResolution,
      }
    }
    return failure(`weather Pack does not support query Capability: ${config.request.capabilityId}`)
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err))
  }
}
