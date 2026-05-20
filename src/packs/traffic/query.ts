import { z } from 'zod'
import type { GeoJsonLineString, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { geoJsonLineStringSchema, objectIdSchema, pointFromPosition, routeDistanceMeters } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import { trafficDomainDataSchema, trafficDomainId } from './model.ts'

const objectQuerySchema = z.object({
  objectId: objectIdSchema,
})

const routeQuerySchema = z.object({
  route: geoJsonLineStringSchema,
  toleranceM: z.number().finite().positive().max(2000).default(220),
})

const success = (request: PackQueryRequest, result: unknown, generatedAt: IsoTimestamp): PackQueryResponse => ({
  ok: true,
  packId: request.packId,
  kind: request.kind,
  result,
  generatedAt,
})

const failure = (request: PackQueryRequest, reason: string, generatedAt: IsoTimestamp): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt,
})

const trafficObjects = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<OperationalObject> =>
  objects.filter(object => object.domain === trafficDomainId && trafficDomainDataSchema.safeParse(object.domainData).success)

const pointDistanceToLine = (point: GeoJsonPoint, line: GeoJsonLineString): number =>
  Math.min(...line.coordinates.map(coordinate => routeDistanceMeters(point, pointFromPosition(coordinate))))

const pointInPolygon = (
  point: GeoJsonPoint,
  polygon: NonNullable<OperationalObject['spatial']['geometry']> & { readonly type: 'Polygon' },
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

const routeIntersectsTraffic = (
  route: GeoJsonLineString,
  traffic: OperationalObject,
  toleranceM: number,
): boolean => {
  const geometry = traffic.spatial.geometry
  if (!geometry) return false
  if (geometry.type === 'LineString') {
    return route.coordinates.some(coordinate => pointDistanceToLine(pointFromPosition(coordinate), geometry) <= toleranceM)
  }
  if (geometry.type === 'Polygon') {
    return route.coordinates.some(coordinate => pointInPolygon(pointFromPosition(coordinate), geometry))
  }
  return false
}

export const answerTrafficQuery = (config: {
  readonly request: PackQueryRequest
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
}): PackQueryResponse => {
  try {
    const conditions = trafficObjects(config.objects)
    if (config.request.kind === 'traffic.conditions') {
      return success(config.request, { conditions }, config.at)
    }
    if (config.request.kind === 'traffic.condition') {
      const payload = objectQuerySchema.parse(config.request.payload)
      const condition = conditions.find(object => object.id === payload.objectId)
      if (!condition) return failure(config.request, `traffic condition not found: ${payload.objectId}`, config.at)
      return success(config.request, { condition }, config.at)
    }
    if (config.request.kind === 'traffic.conditionsForRoute') {
      const payload = routeQuerySchema.parse(config.request.payload)
      const matchingConditions = conditions.filter(condition => routeIntersectsTraffic(payload.route, condition, payload.toleranceM))
      return success(config.request, { conditions: matchingConditions }, config.at)
    }
    return failure(config.request, `traffic pack does not support query kind: ${config.request.kind}`, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
