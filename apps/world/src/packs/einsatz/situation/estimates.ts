import { routeDistanceMeters, type GeoJsonPoint } from '../../../core/model/index.ts'
import { refusal } from '../refusal.ts'
import type { Eta } from '../recommendation-schema.ts'
import type { Step, StepTarget } from '../steps.ts'
import { predictedDelivery } from '../engine/delivery.ts'
import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from '../engine/model.ts'
import { msToArrival, speedFactor } from '../engine/movement.ts'
import { isMoving } from '../engine/rules.ts'

/**
 * Arrival estimates of a unit's plan for the read models, without routing.
 * The active stop's arrival is what is left of the unit's own leg at its
 * current pace, its turnout included. A queued stop has no route until it
 * comes up: a unit that moves in straight lines estimates it from the stop
 * before, its time on task and turnout included; a road unit's queued stop
 * has no estimate until it is routed, and says so.
 */

const notRouted = (from: GeoJsonPoint, to: GeoJsonPoint): Eta =>
  ({ kind: 'unavailable', reason: refusal('routing_unavailable', 'Not routed until the stop comes up'), straightDistanceM: routeDistanceMeters(from, to) })

/** Where a stop leads on the map; an engage stop moves the unit nowhere. */
export const stopPoint = (state: EngineState, target: StepTarget): GeoJsonPoint | undefined => {
  if ('point' in target) return target.point
  if ('taskId' in target) return state.tasks.get(target.taskId)?.point
  if ('siteId' in target) return state.units.has(target.siteId) ? motionOf(state, target.siteId).point : undefined
  return undefined
}

export interface PlanEstimate {
  /** Per stop of the plan, in order: its arrival, null once there or for a stop that moves nothing. */
  readonly stops: ReadonlyArray<Eta | null>
  /** The predicted delivery after the plan and its arrival; undefined when there is none. */
  readonly delivery: { readonly site: UnitRecord; readonly eta: Eta } | undefined
}

export const planEstimate = (state: EngineState, unit: UnitRecord): PlanEstimate => {
  const mobility = unitTypeOf(state.catalog, unit).components.mobility
  const onSceneS = unitTypeOf(state.catalog, unit).components.service?.onSceneS ?? 0
  const motion = motionOf(state, unit.id)
  let at = motion.point
  let seconds = 0
  /** Unknown once a road unit's stop has no route: nothing after it can be timed. */
  let timed = true
  const stops: Array<Eta | null> = []
  const leg = unit.leg
  const routedKind = (provider: string): 'routed' | 'straight-line' => provider === 'direct' ? 'straight-line' : 'routed'
  const after = (step: Step, index: number): void => {
    const to = stopPoint(state, step.target)
    if (to === undefined || mobility === undefined) {
      stops.push(null)
      return
    }
    if (index === 0 && step.state === 'active') {
      if (leg !== undefined && (isMoving(unit) || unit.phase === 'mobilizing')) {
        const travelMs = msToArrival(leg, motion.progressMs, speedFactor(motion.impacts))
        const turnoutMs = unit.phase === 'mobilizing' ? Math.max(0, (unit.phaseDueMs ?? state.timeMs) - state.timeMs) : 0
        if (travelMs === undefined) {
          timed = false
          stops.push({ kind: 'unavailable', reason: refusal('routing_unavailable', `${unit.label} is stopped`), straightDistanceM: routeDistanceMeters(at, to) })
        } else {
          seconds = (turnoutMs + travelMs) / 1_000
          stops.push({ kind: routedKind(leg.provider), seconds, distanceM: Math.max(0, leg.distanceM * (1 - motion.progressMs / Math.max(1, leg.durationMs))) })
        }
      } else {
        stops.push(null)
        seconds = unit.phaseDueMs === undefined ? 0 : Math.max(0, (unit.phaseDueMs - state.timeMs) / 1_000)
      }
      if ('taskId' in step.target && unit.phase !== 'on-task') seconds += onSceneS
      at = to
      return
    }
    const distanceM = routeDistanceMeters(at, to)
    if (!timed || mobility.mode === 'road') {
      timed = false
      stops.push(notRouted(at, to))
    } else {
      seconds += ('taskId' in step.target ? mobility.mobilizeS : 0) + distanceM / mobility.speedMps
      stops.push({ kind: 'straight-line', seconds, distanceM })
      if ('taskId' in step.target) seconds += onSceneS
    }
    at = to
  }
  unit.orders.forEach(after)
  const predicted = predictedDelivery(state, unit.id)
  if (predicted === undefined || mobility === undefined) return { stops, delivery: undefined }
  const to = motionOf(state, predicted.site.id).point
  const distanceM = routeDistanceMeters(predicted.from, to)
  const eta: Eta = !timed || mobility.mode === 'road'
    ? notRouted(predicted.from, to)
    : { kind: 'straight-line', seconds: seconds + distanceM / mobility.speedMps, distanceM }
  return { stops, delivery: { site: predicted.site, eta } }
}
