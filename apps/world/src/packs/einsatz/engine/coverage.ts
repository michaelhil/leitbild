import type { UnitType } from '../config-schema.ts'
import { templateOf, unitTypeOf, type Catalog, type EngineState, type TaskCoverage, type TaskRecord, type UnitRecord } from './model.ts'
import { committedPhases, conditionReasons, isDestroyed, linksToTask, meetsRequirement, providesFor } from './rules.ts'
import { byId, countOf, countsOf, total, type Counts } from './values.ts'

/** What a role can serve on a task's side: the services its commandable units provide and the load classes they carry. */
export interface RoleView {
  readonly provides: ReadonlySet<string>
  readonly carries: ReadonlySet<string>
}

export const roleViewOf = (catalog: Catalog, units: Iterable<UnitRecord>): RoleView => {
  const types = [...units].map(unit => unitTypeOf(catalog, unit))
  return {
    provides: new Set(types.flatMap(type => type.components.service?.provides ?? [])),
    carries: new Set(types.flatMap(type => type.components.carry?.classes ?? [])),
  }
}

/** The role view of an actor on a task: its commandable units of the task's side that are not destroyed. */
export const roleViewFor = (state: EngineState, commandable: (unit: UnitRecord) => boolean, task: TaskRecord): RoleView =>
  roleViewOf(state.catalog, [...state.units.values()].filter(unit => commandable(unit) && linksToTask(unit, task) && !isDestroyed(unit)))

/** Units committed to a task and counted towards it: on its side, not destroyed, ordered by id. */
export const assignedTo = (units: Iterable<UnitRecord>, task: TaskRecord): UnitRecord[] =>
  [...units].filter(unit => unit.taskId === task.id && committedPhases.includes(unit.phase) && !isDestroyed(unit) && linksToTask(unit, task)).sort(byId)

/** Units counted as if sent to the task now: on their way. */
export const asAssigned = (units: ReadonlyArray<UnitRecord>, task: Pick<TaskRecord, 'id'>): UnitRecord[] =>
  units.map(unit => ({ ...unit, taskId: task.id, phase: 'en-route' as const }))

const carries = (type: UnitType, classId: string): boolean => type.components.carry?.classes.includes(classId) === true

const freeCapacity = (type: UnitType, unit: UnitRecord): number => {
  const carry = type.components.carry
  return carry === undefined ? 0 : Math.max(0, carry.capacity - total(unit.load))
}

/**
 * Which waiting load each assigned unit's free carry capacity takes, class
 * by class in declared order. Within a class, units carrying fewer classes take load
 * first, keeping a unit that could carry something else for it; ties go by
 * unit id. Coverage reports this allocation and pickup follows it, so load
 * shown as covered is the load its unit picks up.
 */
export const loadAllocation = (catalog: Catalog, task: Pick<TaskRecord, 'loads'>, assigned: ReadonlyArray<UnitRecord>): ReadonlyMap<string, Counts> => {
  const carriers = assigned
    .map(unit => ({ unit, type: unitTypeOf(catalog, unit) }))
    .filter(({ type }) => type.components.carry !== undefined)
    .sort((a, b) => a.type.components.carry!.classes.length - b.type.components.carry!.classes.length || byId(a.unit, b.unit))
  const room = new Map(carriers.map(({ unit, type }) => [unit.id, freeCapacity(type, unit)]))
  const shares = new Map<string, Array<readonly [string, number]>>(carriers.map(({ unit }) => [unit.id, []]))
  for (const classId of catalog.classIds) {
    let waiting = countOf(task.loads, classId)
    for (const { unit, type } of carriers) {
      if (!carries(type, classId)) continue
      const share = Math.min(room.get(unit.id)!, waiting)
      if (share <= 0) continue
      room.set(unit.id, room.get(unit.id)! - share)
      shares.get(unit.id)!.push([classId, share])
      waiting -= share
    }
  }
  return new Map([...shares].map(([id, entries]) => [id, countsOf(entries)]))
}

const loadCoverage = (catalog: Catalog, task: Pick<TaskRecord, 'loads'>, assigned: ReadonlyArray<UnitRecord>): TaskCoverage['loads'] => {
  const shares = [...loadAllocation(catalog, task, assigned).values()]
  return catalog.classIds.filter(classId => countOf(task.loads, classId) > 0).map(classId => ({
    classId,
    waiting: countOf(task.loads, classId),
    covered: shares.reduce((sum, share) => sum + countOf(share, classId), 0),
  }))
}

/**
 * Coverage of a task by the given assigned units: per requirement, the
 * units meeting it on their way, on task and finished; per waiting load
 * class, how much free carry capacity covers it.
 */
export const coverageOf = (catalog: Catalog, task: Pick<TaskRecord, 'id' | 'template' | 'served' | 'loads'>, assigned: ReadonlyArray<UnitRecord>): TaskCoverage => ({
  requirements: templateOf(catalog, task).requires.map(requirement => {
    const meeting = assigned.filter(unit => meetsRequirement(catalog, unit, requirement))
    return {
      provides: requirement.provides,
      count: requirement.count,
      enRoute: meeting.filter(unit => unit.phase !== 'on-task').length,
      onTask: meeting.filter(unit => unit.phase === 'on-task').length,
      completed: countOf(task.served, requirement.provides),
    }
  }),
  loads: loadCoverage(catalog, task, assigned),
})

/**
 * A task's priority: the one it names (an item's or `task.create`'s), else
 * its template's, else the lowest declared. Load never changes it.
 */
export const taskPriorityOf = (catalog: Catalog, template: string, named: string | undefined): string => {
  const own = named ?? catalog.templates.get(template)?.priority
  if (own !== undefined) return own
  const lowest = catalog.priorities.at(-1)
  if (lowest === undefined) throw new Error(`Task template ${template}: no priority is declared, so the task has no priority`)
  return lowest.id
}

/** A report has nothing to serve: no requirements and never any load. It closes only when closed explicitly. */
export const isReport = (catalog: Catalog, task: TaskRecord): boolean =>
  templateOf(catalog, task).requires.length === 0 && total(task.loads) === 0 && total(task.pickedUp) === 0

/** Done: every requirement has completed on task and all load is picked up. */
export const isDone = (catalog: Catalog, task: TaskRecord, coverage: TaskCoverage): boolean =>
  !isReport(catalog, task) && coverage.requirements.every(entry => entry.completed >= entry.count) && total(task.loads) === 0

const short = (entry: TaskCoverage['requirements'][number]): boolean => entry.enRoute + entry.onTask + entry.completed < entry.count

/**
 * Whether a task still needs something from a role: an uncovered load
 * class one of the role's units carries, a requirement short that one of
 * them provides, or, an open report, attention.
 */
export const needsFrom = (catalog: Catalog, task: TaskRecord, coverage: TaskCoverage, view: RoleView): boolean => {
  if (task.closedAtMs !== undefined) return false
  if (coverage.loads.some(entry => entry.covered < entry.waiting && view.carries.has(entry.classId))) return true
  return coverage.requirements.some(entry => view.provides.has(entry.provides) && short(entry)) || isReport(catalog, task)
}

/** The units a task's coverage counts with a proposal: those assigned to it, and the proposal's as if sent now. */
export const countedFor = (state: EngineState, task: TaskRecord, proposal: ReadonlyArray<UnitRecord>): UnitRecord[] =>
  [...assignedTo(state.units.values(), task), ...asAssigned(proposal, task)]

/** Whether the task still needs something from the role once the proposal's units are counted on their way. */
export const stillNeeds = (state: EngineState, task: TaskRecord, view: RoleView, proposal: ReadonlyArray<UnitRecord>): boolean =>
  needsFrom(state.catalog, task, coverageOf(state.catalog, task, countedFor(state, task, proposal)), view)

export interface Contribution {
  /** Counting the unit changes how far some requirement is filled, up to its count, or how much load of some class is covered. */
  readonly adds: boolean
  /** Why the unit fails the `where` of requirements whose service it provides. */
  readonly unmet: ReadonlyArray<string>
  /** Something the unit could serve is already covered without it. */
  readonly covered: boolean
}

/** How far each requirement is filled, up to its count, then the load covered per class. */
const filled = (coverage: TaskCoverage): number[] => [
  ...coverage.requirements.map(entry => Math.min(entry.count, entry.enRoute + entry.onTask + entry.completed)),
  ...coverage.loads.map(entry => entry.covered),
]

/**
 * What a unit contributes to a task beside `counted`: the assigned units and
 * the rest of a proposal, counted as on their way (`countedFor`); the unit
 * itself is set aside if listed. It adds only when counting it changes a
 * requirement or a covered load class, so the judgement never depends on the
 * order in which a proposal names its units.
 */
export const contributionOf = (catalog: Catalog, task: TaskRecord, counted: ReadonlyArray<UnitRecord>, unit: UnitRecord): Contribution => {
  const others = counted.filter(other => other.id !== unit.id)
  const without = coverageOf(catalog, task, others)
  const withUnit = filled(coverageOf(catalog, task, [...others, ...asAssigned([unit], task)]))
  const type = unitTypeOf(catalog, unit)
  const requirements = templateOf(catalog, task).requires.flatMap((requirement, index) => {
    if (!providesFor(type, requirement)) return []
    const reasons = conditionReasons(catalog, unit, requirement)
    return [{ reasons, open: reasons.length === 0 && short(without.requirements[index]!) }]
  })
  const loads = without.loads.filter(entry => carries(type, entry.classId) && freeCapacity(type, unit) > 0)
  const matched = requirements.filter(entry => entry.reasons.length === 0)
  return {
    adds: filled(without).some((value, index) => value !== withUnit[index]),
    unmet: requirements.flatMap(entry => entry.reasons),
    covered: matched.some(entry => !entry.open) || loads.some(entry => entry.covered >= entry.waiting),
  }
}
