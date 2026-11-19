import { z } from 'zod'
import { geoPointFromLonLat, idSchema, type GeoJsonLineString, type GeoJsonPoint, type OperationalObject } from '../../core/model/index.ts'
import type { PackMapFeature, PackMapFeatureQuery } from '../../core/packs/protocol.ts'
import { einsatzPackId } from './ids.ts'
import { planExpectationSchema } from './order-schema.ts'
import { ordersSchema, type Step } from './steps.ts'

/**
 * The planned path of each unit's job chain, read from the objects in the
 * viewer's picture: presentation only, derived like everything the map
 * shows, never a simulation input. The active leg is the route the unit's
 * object carries (`spatial.route.planned`), which the World map already
 * draws as the unit's route. We derive the endpoints of each queued leg
 * from the plan, and the runtime obtains its geometry for display. A step
 * without travel adds no leg.
 */

const unitSchema = z.object({ type: z.literal('unit'), integrity: z.string(), orders: ordersSchema }).loose()

/** The endpoints of a queued travel leg, before routing. */
export interface PlannedSegment {
  readonly stepId: string
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
  /** The label of the target object; absent for a point on open ground. */
  readonly targetLabel?: string
}

export interface PlannedPath {
  readonly unitId: string
  readonly label: string
  /** The route of the active step while the unit travels it. */
  readonly activeLeg?: GeoJsonLineString
  readonly segments: ReadonlyArray<PlannedSegment>
}

const pointOf = (object: OperationalObject): GeoJsonPoint | undefined => object.spatial.position?.point

/** Where a step leads on the map, with the target's label: a task's or site's position, or the point. */
const stepEnd = (step: Step, byId: ReadonlyMap<string, OperationalObject>): { readonly point: GeoJsonPoint; readonly label?: string } | 'none' | 'unseen' => {
  if ('point' in step.target) return { point: step.target.point }
  if ('trackId' in step.target) return 'none'
  const target = byId.get('taskId' in step.target ? step.target.taskId : step.target.siteId)
  const point = target === undefined ? undefined : pointOf(target)
  return target === undefined || point === undefined ? 'unseen' : { point, label: target.label }
}

/**
 * The planned path of every living unit with steps. A target the picture
 * does not hold, which a step of the same side never names once the engine
 * has skipped it, ends that unit's path there: nothing is drawn past a
 * position the picture cannot place.
 */
export const plannedPaths = (objects: ReadonlyArray<OperationalObject>): PlannedPath[] => {
  const byId = new Map(objects.map(object => [object.id as string, object]))
  return objects.flatMap(object => {
    if (object.packId !== einsatzPackId || (object.packData as { readonly type?: unknown } | undefined)?.type !== 'unit') return []
    const unit = unitSchema.parse(object.packData)
    if (unit.integrity === 'destroyed' || unit.orders.length === 0) return []
    const orders = unit.orders
    const head = orders[0]!
    const route = head.state === 'active' ? object.spatial.route?.planned : undefined
    const activeEnd = head.state === 'active' ? stepEnd(head, byId) : 'none'
    let from = activeEnd === 'unseen' ? undefined
      : route !== undefined ? geoPointFromLonLat(...route.coordinates.at(-1)!)
      : activeEnd === 'none' ? pointOf(object) : activeEnd.point
    if (from === undefined) return []
    const segments: PlannedSegment[] = []
    for (const step of head.state === 'active' ? orders.slice(1) : orders) {
      const end = stepEnd(step, byId)
      if (end === 'unseen') break
      if (end === 'none') continue
      segments.push({ stepId: step.id, from, to: end.point, ...(end.label === undefined ? {} : { targetLabel: end.label }) })
      from = end.point
    }
    return [{ unitId: object.id, label: object.label, ...(route === undefined ? {} : { activeLeg: route }), segments }]
  })
}

const pathColor = '#0a7daf'

export const queuedPlanRoutesId = 'world.einsatz.unit.plan.routes'

export const queuedPlanRoutesInputSchema = z.object({
  unitId: idSchema.describe('A unit whose queued routes the map should show.'),
  expectedPlan: planExpectationSchema,
}).strict()

export const queuedPlanRoutesQuery = (objects: ReadonlyArray<OperationalObject>, selectedId?: string): ReadonlyArray<PackMapFeatureQuery> => {
  const object = objects.find(entry => entry.id === selectedId && entry.packId === einsatzPackId)
  if (object === undefined || (object.packData as { readonly type?: unknown } | undefined)?.type !== 'unit') return []
  const unit = unitSchema.parse(object.packData)
  if (unit.integrity === 'destroyed' || !unit.orders.some(step => step.state === 'queued' && !('trackId' in step.target))) return []
  return [{
    capabilityId: queuedPlanRoutesId,
    input: { unitId: object.id, expectedPlan: unit.orders.map(({ id, state }) => ({ id, state })) },
  }]
}

/** A dotted queued route under the operational icons, separate from the active solid route. */
export const queuedRouteFeature = (path: PlannedPath, segment: PlannedSegment, geometry: GeoJsonLineString): PackMapFeature => ({
  id: `einsatz-plan:${path.unitId}:${segment.stepId}`,
  categoryId: 'einsatz-units',
  geometry,
  color: pathColor,
  lineColor: pathColor,
  lineOpacity: 0.9,
  lineWidth: 2.5,
  lineDashed: true,
  sortKey: 23,
  summary: `${path.label} · next: ${segment.targetLabel ?? 'a map point'}`,
})

/** Stop ids repeat across units, so a waypoint's feature id names both records. */
export const waypointFeatureId = (unitId: string, stopId: string): string => `einsatz-waypoint:${encodeURIComponent(unitId)}:${stopId}`

/**
 * Draw a pin where the selected unit's stop has no map object. The pin takes
 * no tap: a tap there is open ground, a point target for the selected unit.
 * A stop is removed only with the × on its row in the unit card.
 */
export const plannedWaypointFeatures = (
  objects: ReadonlyArray<OperationalObject>,
  categoryId: string,
  selectedId?: string,
): PackMapFeature[] => {
  if (selectedId === undefined) return []
  const object = objects.find(entry => entry.id === selectedId && entry.packId === einsatzPackId)
  if (object === undefined || (object.packData as { readonly type?: unknown } | undefined)?.type !== 'unit') return []
  const unit = unitSchema.parse(object.packData)
  if (unit.integrity === 'destroyed') return []
  return unit.orders.flatMap((step, index) => {
    if (!('point' in step.target)) return []
    return [{
      id: waypointFeatureId(object.id, step.id),
      categoryId,
      geometry: step.target.point,
      symbol: { icon: 'map-pin' },
      color: '#a83f4d',
      summary: `${object.label} · Stop ${index + 1}`,
    }]
  })
}
