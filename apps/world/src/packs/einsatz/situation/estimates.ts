import { routeDistanceMeters, type GeoJsonPoint } from '../../../core/model/index.ts'
import { refusal } from '../refusal.ts'
import type { Eta } from '../recommendation-schema.ts'
import type { Step, StepTarget } from '../steps.ts'
import { predictedDelivery } from '../engine/delivery.ts'
import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from '../engine/model.ts'
import { arrivalInS, legUnderWay, stopDoneInS } from '../engine/estimates.ts'
import { stoppedEta } from '../eta.ts'

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
  let at = motionOf(state, unit.id).point
  let seconds = 0
  /** Unknown once a road unit's stop has no route: nothing after it can be timed. */
  let timed = true
  const stops: Array<Eta | null> = []
  const routedKind = (provider: string): 'routed' | 'straight-line' => provider === 'direct' ? 'straight-line' : 'routed'
  const after = (step: Step, index: number): void => {
    const to = stopPoint(state, step.target)
    if (to === undefined || mobility === undefined) {
      stops.push(null)
      return
    }
    if (index === 0 && step.state === 'active') {
      // The active stop is timed as the engine runs it (`engine/estimates.ts`).
      const leg = legUnderWay(unit) ? unit.leg : undefined
      if (leg === undefined) stops.push(null)
      else {
        const arrival = arrivalInS(state, unit)
        stops.push(arrival === undefined
          ? stoppedEta(unit, at, to)
          : { kind: routedKind(leg.provider), seconds: arrival, distanceM: Math.max(0, leg.distanceM * (1 - motionOf(state, unit.id).progressMs / Math.max(1, leg.durationMs))) })
      }
      const done = stopDoneInS(state, unit)
      if (done === undefined) timed = false
      else seconds = done
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
