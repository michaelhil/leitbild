import { z } from 'zod'
import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { geoJsonLineStringSchema, geoJsonPointSchema, geoJsonPolygonSchema, nowIso, pointFromPosition, routeDistanceMeters } from '../../core/model/index.ts'
import type { PackMapAreaFeature, PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import type { WeatherSparseField } from './cell-field.ts'
import { weatherSampleAtPointFromSparseField, weatherSparseFieldStats } from './cell-field.ts'
import { weatherPresentationSeverityForState } from './conditions.ts'
import { projectWeatherFieldForMap } from './projection.ts'

const weatherPointQuerySchema = z.object({
  point: geoJsonPointSchema,
})

const weatherRouteQuerySchema = z.object({
  route: geoJsonLineStringSchema,
  intervalM: z.number().finite().positive().max(5000).default(500),
})

const weatherAreaQuerySchema = z.object({
  area: geoJsonPolygonSchema,
})

const weatherMapFeaturesQuerySchema = z.object({
  viewport: geoJsonPolygonSchema,
  zoom: z.number().finite().min(0).max(24),
  layers: z.array(z.enum(['baseGrid', 'affectedCells', 'influenceShapes'])).default(['baseGrid', 'affectedCells', 'influenceShapes']),
})

const success = (
  request: PackQueryRequest,
  result: unknown,
  generatedAt: IsoTimestamp = nowIso(),
): PackQueryResponse => ({
  ok: true,
  packId: request.packId,
  kind: request.kind,
  result,
  generatedAt,
})

const failure = (
  request: PackQueryRequest,
  reason: string,
  generatedAt: IsoTimestamp = nowIso(),
): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt,
})

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
  readonly request: PackQueryRequest
  readonly field: WeatherSparseField
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
}): PackQueryResponse => {
  try {
    if (config.request.kind === 'weather.sampleAtPoint') {
      const payload = weatherPointQuerySchema.parse(config.request.payload)
      return success(config.request, weatherSampleAtPointFromSparseField({
        field: config.field,
        point: payload.point,
        at: config.at,
      }), config.at)
    }
    if (config.request.kind === 'weather.sampleAlongRoute') {
      const payload = weatherRouteQuerySchema.parse(config.request.payload)
      const points = samplePointsAlongRoute(payload.route, payload.intervalM)
      const samples = points.map(point => ({
        point,
        sample: weatherSampleAtPointFromSparseField({ field: config.field, point, at: config.at }),
      }))
      return success(config.request, {
        samples,
        summary: summarizeSamples(samples.map(item => item.sample)),
      }, config.at)
    }
    if (config.request.kind === 'weather.summarizeArea') {
      const payload = weatherAreaQuerySchema.parse(config.request.payload)
      const cells = [...config.field.cells.values()].filter(cell => pointInPolygon(cell.center, payload.area))
      return success(config.request, {
        cellCount: cells.length,
        summary: summarizeSamples(cells.map(cell => ({
          state: cell.state,
          quality: { provenance: cell.activeInfluenceIds.length > 0 ? 'inferred' : 'scenario', confidence: 0.7, validAt: cell.updatedAt },
          activeInfluenceIds: cell.activeInfluenceIds,
        }))),
      }, config.at)
    }
    if (config.request.kind === 'weather.mapFeatures') {
      const payload = weatherMapFeaturesQuerySchema.parse(config.request.payload)
      const features = projectWeatherFieldForMap({
        field: config.field,
        objects: config.objects,
        viewport: payload.viewport,
        zoom: payload.zoom,
        at: config.at,
      }).filter((feature: PackMapAreaFeature): boolean => {
        if (feature.id.startsWith('weather-grid:')) return payload.layers.includes('baseGrid')
        if (feature.id.startsWith('weather-cell:')) return payload.layers.includes('affectedCells')
        return payload.layers.includes('influenceShapes')
      })
      return success(config.request, {
        features,
        metadata: {
          ...weatherSparseFieldStats(config.field),
          truthResolution: config.field.grid.truthResolution,
        },
      }, config.at)
    }
    if (config.request.kind === 'weather.fieldStats') {
      return success(config.request, {
        ...weatherSparseFieldStats(config.field),
        truthResolution: config.field.grid.truthResolution,
      }, config.at)
    }
    return failure(config.request, `weather pack does not support query kind: ${config.request.kind}`, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
