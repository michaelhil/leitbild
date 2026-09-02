import { z } from 'zod'
import type { GeoJsonLineString, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { geoJsonLineStringSchema, objectIdSchema, operationalObjectSchema, pointFromPosition, routeDistanceMeters } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { definePackQueryCapability } from '../../simulation/capabilities.ts'
import { trafficPackDataSchema, trafficPackId } from './model.ts'

const objectQuerySchema = z.object({
  objectId: objectIdSchema,
})

const routeQuerySchema = z.object({
  route: geoJsonLineStringSchema,
  toleranceM: z.number().finite().positive().max(2000).default(220),
})

export const trafficQueryKinds = [
  'world.traffic.conditions',
  'world.traffic.condition',
  'world.traffic.conditions-for-route',
] as const

const conditionsResultSchema = z.object({ conditions: z.array(operationalObjectSchema) }).strict()
const conditionResultSchema = z.object({ condition: operationalObjectSchema }).strict()

export const trafficQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  definePackQueryCapability({ id: trafficQueryKinds[0], title: 'List traffic conditions', description: 'Lists current traffic conditions in the Simulation Run.', input: z.object({}).strict(), output: conditionsResultSchema }),
  definePackQueryCapability({ id: trafficQueryKinds[1], title: 'Read traffic condition', description: 'Reads one current traffic condition by object id.', input: objectQuerySchema, output: conditionResultSchema }),
  definePackQueryCapability({ id: trafficQueryKinds[2], title: 'Find traffic conditions for route', description: 'Returns traffic conditions intersecting a route within a bounded tolerance.', input: routeQuerySchema, output: conditionsResultSchema }),
]

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
  objects.filter(object => object.packId === trafficPackId && trafficPackDataSchema.safeParse(object.packData).success)

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
    if (config.request.kind === trafficQueryKinds[0]) {
      return success(config.request, { conditions }, config.at)
    }
    if (config.request.kind === trafficQueryKinds[1]) {
      const payload = objectQuerySchema.parse(config.request.payload)
      const condition = conditions.find(object => object.id === payload.objectId)
      if (!condition) return failure(config.request, `traffic condition not found: ${payload.objectId}`, config.at)
      return success(config.request, { condition }, config.at)
    }
    if (config.request.kind === trafficQueryKinds[2]) {
      const payload = routeQuerySchema.parse(config.request.payload)
      const matchingConditions = conditions.filter(condition => routeIntersectsTraffic(payload.route, condition, payload.toleranceM))
      return success(config.request, { conditions: matchingConditions }, config.at)
    }
    return failure(config.request, `traffic pack does not support query kind: ${config.request.kind}`, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
