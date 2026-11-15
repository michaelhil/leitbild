import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from './model.ts'
import { msToArrival, speedFactor } from './movement.ts'
import { isMoving } from './rules.ts'

/**
 * Estimates of a unit's active stop as the engine runs it now. The read
 * models time a plan from them, and an order's `when_required` refusal says
 * when a busy unit is free.
 */

/** Whether a unit is on its way along its active leg: turning out for it, or travelling it. */
export const legUnderWay = (unit: UnitRecord): boolean => unit.leg !== undefined && (isMoving(unit) || unit.phase === 'mobilizing')

/**
 * Seconds until a unit under way (`legUnderWay`) arrives where its leg
 * leads: what is left of its turnout, then of the leg at its current pace.
 * Undefined while its route impacts stop it.
 */
export const arrivalInS = (state: EngineState, unit: UnitRecord): number | undefined => {
  if (unit.leg === undefined) throw new Error(`${unit.id} has no leg`)
  const motion = motionOf(state, unit.id)
  const travelMs = msToArrival(unit.leg, motion.progressMs, speedFactor(motion.impacts))
  if (travelMs === undefined) return undefined
  const turnoutMs = unit.phase === 'mobilizing' ? Math.max(0, (unit.phaseDueMs ?? state.timeMs) - state.timeMs) : 0
  return (turnoutMs + travelMs) / 1_000
}

/**
 * Seconds until a unit is done with its active stop: under way, its arrival
 * (`arrivalInS`), then its whole time on task when the stop is a task; once
 * there, what is left of the phase it stands in (work on task, a handover).
 * Undefined while its route impacts stop it.
 */
export const stopDoneInS = (state: EngineState, unit: UnitRecord): number | undefined => {
  const onSceneS = unit.taskId === undefined || unit.phase === 'on-task' ? 0 : unitTypeOf(state.catalog, unit).components.service?.onSceneS ?? 0
  if (!legUnderWay(unit)) return (unit.phaseDueMs === undefined ? 0 : Math.max(0, (unit.phaseDueMs - state.timeMs) / 1_000)) + onSceneS
  const arrival = arrivalInS(state, unit)
  return arrival === undefined ? undefined : arrival + onSceneS
}

/**
 * Seconds until a busy unit's work on its task is done (`stopDoneInS`, its
 * task being its active stop). Undefined for a unit serving no task, and
 * where the engine cannot tell.
 */
export const freeInS = (state: EngineState, unit: UnitRecord): number | undefined =>
  unit.taskId === undefined ? undefined : stopDoneInS(state, unit)
