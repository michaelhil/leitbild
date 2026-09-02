import { z } from 'zod'
import type { GeoJsonLineString, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { geoJsonLineStringSchema, objectIdSchema, operationalObjectSchema, pointFromPosition, routeDistanceMeters } from '../../core/model/index.ts'
import type { PackRuntimeQuery, SimulationCapability } from '../../simulation/protocol.ts'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import { trafficPackDataSchema, trafficPackId } from './model.ts'

const objectQuerySchema = z.object({
  objectId: objectIdSchema,
}).strict()

const routeQuerySchema = z.object({
  route: geoJsonLineStringSchema,
  toleranceM: z.number().finite().positive().max(2000).default(220),
}).strict()

export const trafficQueryKinds = [
  'world.traffic.conditions',
  'world.traffic.condition',
  'world.traffic.conditions-for-route',
] as const

const conditionsResultSchema = z.object({ conditions: z.array(operationalObjectSchema) }).strict()
const conditionResultSchema = z.object({ condition: operationalObjectSchema }).strict()

export const trafficQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  defineSimulationQueryCapability({ id: trafficQueryKinds[0], title: 'List traffic conditions', description: 'Lists current traffic conditions in the Simulation Run.', input: z.object({}).strict(), output: conditionsResultSchema }),
  defineSimulationQueryCapability({ id: trafficQueryKinds[1], title: 'Read traffic condition', description: 'Reads one current traffic condition by object id.', input: objectQuerySchema, output: conditionResultSchema }),
  defineSimulationQueryCapability({ id: trafficQueryKinds[2], title: 'Find traffic conditions for route', description: 'Returns traffic conditions intersecting a route within a bounded tolerance.', input: routeQuerySchema, output: conditionsResultSchema }),
]

const failure = (reason: string): never => { throw new Error(reason) }

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
  readonly request: PackRuntimeQuery
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
}): unknown => {
  try {
    const conditions = trafficObjects(config.objects)
    if (config.request.capabilityId === trafficQueryKinds[0]) {
      return { conditions }
    }
    if (config.request.capabilityId === trafficQueryKinds[1]) {
      const payload = objectQuerySchema.parse(config.request.input)
      const condition = conditions.find(object => object.id === payload.objectId)
      if (!condition) return failure(`traffic condition not found: ${payload.objectId}`)
      return { condition }
    }
    if (config.request.capabilityId === trafficQueryKinds[2]) {
      const payload = routeQuerySchema.parse(config.request.input)
      const matchingConditions = conditions.filter(condition => routeIntersectsTraffic(payload.route, condition, payload.toleranceM))
      return { conditions: matchingConditions }
    }
    return failure(`traffic Pack does not support query Capability: ${config.request.capabilityId}`)
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err))
  }
}
