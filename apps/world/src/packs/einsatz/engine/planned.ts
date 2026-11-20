import { deliversByOrder, loadAfter } from './chain.ts'
import { asAssigned, assignedTo, contributionOf, coverageOf } from './coverage.ts'
import type { EngineState, TaskCoverage, TaskRecord, UnitRecord } from './model.ts'
import { isDestroyed, linksToTask } from './rules.ts'
import { byId, patch } from './values.ts'

/**
 * Later stops: a task another unit's plan holds as a queued stop. Only a
 * unit's active stop counts towards a task's coverage, so the engine never
 * waits on a stop that may yet be skipped. Later stops count where someone
 * decides who else to send: `recommend` counts them as on their way, the
 * situation shows what they will cover, and unit options warn before a unit
 * is sent to what they already cover.
 */

/** A later stop at a task: its unit as it will stand when the stop comes up, carrying what it will carry then, and the stop's place in its plan, from 1. */
export interface PlannedStop {
  readonly unit: UnitRecord
  readonly stop: number
}

/** The later stops other units hold at a task: units on its side, not destroyed and not assigned to it, by unit id. */
export const plannedStops = (state: EngineState, task: TaskRecord): PlannedStop[] =>
  [...state.units.values()].sort(byId).flatMap(unit => {
    if (unit.taskId === task.id || isDestroyed(unit) || !linksToTask(unit, task)) return []
    const index = unit.orders.findIndex(step => step.state === 'queued' && 'taskId' in step.target && step.target.taskId === task.id)
    if (index < 0) return []
    // What it carries there: a deliver order delivers before any other step, as `loadAfter` reads it.
    const load = deliversByOrder(state, unit) ? {} : loadAfter(state, unit, index)
    return [{ unit: patch(unit, { load, taskId: undefined }), stop: index + 1 }]
  })

/** The units a task's coverage counts once its later stops come up: those assigned to it, then the planned ones as if on their way. */
export const countedWithPlanned = (state: EngineState, task: TaskRecord, planned: ReadonlyArray<PlannedStop>): UnitRecord[] =>
  [...assignedTo(state.units.values(), task), ...asAssigned(planned.map(entry => entry.unit), task)]

/** The task's coverage once its later stops come up. */
export const coverageWithPlanned = (state: EngineState, task: TaskRecord, planned: ReadonlyArray<PlannedStop>): TaskCoverage =>
  coverageOf(state.catalog, task, countedWithPlanned(state, task, planned))

/** "C-2 is already stop 2 of A4's plan". */
export const plannedText = (task: Pick<TaskRecord, 'label'>, planned: ReadonlyArray<PlannedStop>): string =>
  `${task.label} is already ${planned.map(entry => `stop ${entry.stop} of ${entry.unit.label}'s plan`).join(' and ')}`

/**
 * Why sending `unit` to the task would double a later stop: what it adds
 * beside the assigned units, other units' later stops already cover. It
 * names the stops whose unit the cover needs, else all of them. Undefined
 * when the unit adds something with those stops counted too, or nothing
 * without them, which an order to it is refused for anyway. The unit is
 * judged free, as it stands once it leaves what it does now.
 */
export const plannedWarning = (state: EngineState, task: TaskRecord, unit: UnitRecord): string | undefined => {
  const planned = plannedStops(state, task).filter(entry => entry.unit.id !== unit.id)
  if (planned.length === 0) return undefined
  const free = patch(unit, { load: {}, taskId: undefined })
  const adds = (stops: ReadonlyArray<PlannedStop>): boolean => contributionOf(state.catalog, task, countedWithPlanned(state, task, stops), free).adds
  if (!adds([]) || adds(planned)) return undefined
  const needed = planned.filter(entry => adds(planned.filter(other => other !== entry)))
  return plannedText(task, needed.length === 0 ? planned : needed)
}
