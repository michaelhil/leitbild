import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from './model.ts'
import { msToArrival, speedFactor } from './movement.ts'

/**
 * Seconds until a busy unit's work on its task is done, as the engine runs
 * it now: what is left of its turnout and its leg at its current pace, then
 * its whole time on task; on task, what is left of it. Undefined for a unit
 * serving no task, and where the engine cannot tell (a leg it has not yet
 * been given).
 */
export const freeInS = (state: EngineState, unit: UnitRecord): number | undefined => {
  if (unit.taskId === undefined) return undefined
  const onSceneS = unitTypeOf(state.catalog, unit).components.service?.onSceneS ?? 0
  if (unit.phase === 'on-task') return unit.phaseDueMs === undefined ? undefined : Math.max(0, (unit.phaseDueMs - state.timeMs) / 1_000)
  if (unit.leg === undefined) return undefined
  const motion = motionOf(state, unit.id)
  const travelMs = msToArrival(unit.leg, motion.progressMs, speedFactor(motion.impacts))
  if (travelMs === undefined) return undefined
  const turnoutMs = unit.phase === 'mobilizing' ? Math.max(0, (unit.phaseDueMs ?? state.timeMs) - state.timeMs) : 0
  return (turnoutMs + travelMs) / 1_000 + onSceneS
}
