import type { StepTarget } from '../steps.ts'
import { changedPlan, deliveryRefusal, planAppend, removeSteps } from './chain.ts'
import { closeDraft, openDraft, putUnit, taskIn, unitIn } from './draft.ts'
import { clockText } from '../text.ts'
import { freeInS } from './estimates.ts'
import { notInPicture, refused, type Refused } from './intent-support.ts'
import type { EngineActor, IntentOf, Plan, RouteNeed } from './intents.ts'
import type { EngineState, Leg, UnitRecord } from './model.ts'
import { planDoNow } from './orders.ts'
import { patch } from './values.ts'

/**
 * `unit.order` and `unit.undo` as one engine plan each. An order gives
 * units a plan of stops, all or nothing: every stop is validated on the
 * state the stops before it leave, and if any is refused nothing changes.
 * Only the first stop of a unit can need a route now; the stops behind it
 * start, and route, when they come up.
 */

/** Busy: the unit works for a task now (turning out, on its way or on task). An order for it must say when. */
export const isBusy = (unit: UnitRecord): boolean => unit.taskId !== undefined

/** "free in about 4:10", where the engine can estimate it. */
const freeText = (state: EngineState, unit: UnitRecord): string => {
  const seconds = freeInS(state, unit)
  return seconds === undefined ? '' : `, free in about ${clockText(seconds)}`
}

/**
 * Stand-in legs for validating the stops after the first on the state the
 * first leaves. They are never committed: a commit applies the legs routed
 * for its own state, and the stops after the first need no route now.
 */
const standInLegs = (routes: ReadonlyArray<RouteNeed>): ReadonlyMap<string, Leg> => new Map(routes.map(route => [route.unitId, {
  geometry: { type: 'LineString' as const, coordinates: [[...route.from.coordinates], [...route.to.coordinates]] },
  durationMs: 0,
  distanceM: 0,
  provider: 'validation',
}]))

const simulate = (state: EngineState, plan: Extract<Plan, { ok: true }>): EngineState => {
  const draft = openDraft(state)
  plan.apply(draft, standInLegs(plan.routes))
  return closeDraft(draft)
}

/** Plans run one after another: each validated on the state the ones before it leave; only the first may route. */
const inSequence = (state: EngineState, first: Plan, rest: ReadonlyArray<(state: EngineState) => Plan>, after: (draft: Parameters<Extract<Plan, { ok: true }>['apply']>[0]) => void): Plan => {
  if (!first.ok) return first
  let current = simulate(state, first)
  const following: Array<Extract<Plan, { ok: true }>> = []
  for (const next of rest) {
    const plan = next(current)
    if (!plan.ok) return plan
    if (plan.routes.length > 0) throw new Error('A stop after the first needs a route before it comes up')
    following.push(plan)
    current = simulate(current, plan)
  }
  return {
    ok: true,
    routes: first.routes,
    notes: [...first.notes, ...following.flatMap(plan => plan.notes)],
    apply: (draft, legs) => {
      first.apply(draft, legs)
      for (const plan of following) plan.apply(draft, new Map())
      after(draft)
    },
  }
}

/** Every plan of a list together; they name different units, so each route answers its own. */
const together = (plans: ReadonlyArray<Plan>): Plan => {
  const refusal = plans.find((plan): plan is Refused => !plan.ok)
  if (refusal !== undefined) return refusal
  const accepted = plans as ReadonlyArray<Extract<Plan, { ok: true }>>
  return {
    ok: true,
    routes: accepted.flatMap(plan => plan.routes),
    notes: accepted.flatMap(plan => plan.notes),
    apply: (draft, legs) => { for (const plan of accepted) plan.apply(draft, legs) },
  }
}

/**
 * Give units a plan, all or nothing.
 * - A busy unit must be ordered alone and with `when` (`when_required`,
 *   naming the task and when it is free).
 * - `when: 'now'` drops a busy unit's current task: `drops` must be that
 *   task (`drops_mismatch`, naming the actual one). The divert rules apply:
 *   not after arrival (`divert_after_arrival`), never from a more urgent task.
 * - `when: 'after'` appends every stop behind the unit's plan; a unit with
 *   an empty plan starts the first at once.
 * - Without `when`, or with `now`, the first stop starts now for every unit
 *   together, its coverage judged over all of them, and the rest follow.
 */
export const planOrder = (state: EngineState, intent: IntentOf<'order'>, actor: EngineActor): Plan => {
  const units: UnitRecord[] = []
  for (const id of intent.units) {
    const unit = state.units.get(id)
    if (unit === undefined) return notInPicture()
    units.push(unit)
  }
  if (intent.expectedPlan !== undefined) {
    const unit = units[0]
    if (units.length !== 1 || unit === undefined) return refused('invalid_input', 'An expected plan names one unit')
    const changed = changedPlan(unit, intent.expectedPlan)
    if (changed) return changed
    if (intent.when === 'now' && unit.orders[0]?.state === 'queued') {
      return refused('unit_committed', `${unit.label} has no active stop to replace yet`)
    }
  }
  const busy = units.filter(isBusy)
  if (busy.length > 0 && units.length > 1) {
    return refused('when_required', `${busy.map(unit => unit.label).join(', ')} ${busy.length === 1 ? 'is' : 'are'} busy: order a busy unit on its own, saying when`)
  }
  const single = busy[0]
  if (single !== undefined && intent.when === undefined) {
    const task = taskIn(state, single.taskId!)
    return refused('when_required', `${single.label} is busy with ${task.label}${freeText(state, single)}: say when, "after" its current job, or "now", dropping ${task.label}`)
  }
  if (intent.when === 'now') {
    for (const unit of units) {
      if (unit.taskId === intent.drops) continue
      const current = unit.taskId === undefined ? undefined : taskIn(state, unit.taskId)
      return refused('drops_mismatch', current === undefined
        ? `${unit.label} works for no task, so it drops none`
        : `${unit.label} works for ${current.label} (${current.id}): name it in drops to take ${unit.label} off it`)
    }
  }
  const [first, ...rest] = intent.stops as [StepTarget, ...StepTarget[]]
  const following = (targets: ReadonlyArray<StepTarget>) => targets.flatMap(to => units.map(unit => (current: EngineState) => planAppend(current, unit.id, to, actor)))
  /**
   * The command becomes the latest of each unit it gave a stop, naming the
   * first of them, which the unit reaches before the others; a unit the
   * order left as it was keeps its own.
   */
  const stamped = (draft: Parameters<Extract<Plan, { ok: true }>['apply']>[0]): void => {
    if (actor.commandId === undefined) return
    for (const unit of units) {
      const current = unitIn(draft, unit.id)
      const firstStop = current.orders.find(step => step.commandId === actor.commandId)
      if (firstStop === undefined) continue
      putUnit(draft, patch(current, { lastCommand: { id: actor.commandId, stepId: firstStop.id, ...(intent.drops === undefined ? {} : { drops: intent.drops }) } }))
    }
  }
  if (intent.when === 'after') {
    const idle = units.filter(unit => unit.orders.length === 0)
    const holding = units.filter(unit => unit.orders.length > 0)
    const start = together([
      ...(idle.length === 0 ? [] : [planDoNow(state, first, idle.map(unit => ({ unit })), actor)]),
      ...holding.map(unit => planAppend(state, unit.id, first, actor)),
    ])
    return inSequence(state, start, following(rest), stamped)
  }
  const start = planDoNow(state, first, units.map(unit => ({ unit, ...(intent.when === 'now' && unit.taskId !== undefined ? { fromTaskId: unit.taskId } : {}) })), actor)
  return inSequence(state, start, following(rest), stamped)
}

/** Phases in which a unit has not yet arrived where its active stop leads. */
const underWay: ReadonlyArray<UnitRecord['phase']> = ['mobilizing', 'en-route', 'transporting']

/**
 * Take back a command's order while none of it has been carried out: the
 * unit's plan still holds the first stop it gave (`lastCommand.stepId`),
 * and the unit has not arrived there. Refused `newer_order_exists` when
 * another command changed the unit's plan since, `nothing_to_undo` once the
 * unit is past that first stop or has arrived at it, after an undo, and for
 * a command that gave no stop (a return, a removed stop). As `unit.stop.remove`, an undo
 * never takes the stop that delivers the load a unit carries
 * (`unit_loaded`). The stops leave quietly: a task's work never left it. An
 * order that dropped a task gives the task back: the unit is sent to it
 * again, which is refused for the reason any order to it would be (the task
 * closed, or covered meanwhile).
 */
export const planUndo = (state: EngineState, intent: IntentOf<'undo'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  const last = unit.lastCommand
  if (last === undefined) return refused('nothing_to_undo', `${unit.label} has no order to undo`)
  if (last.id !== intent.commandId) return refused('newer_order_exists', `A newer order changed ${unit.label}'s plan since; undo that one, or give a new order`)
  if (last.undo === true) return refused('nothing_to_undo', `${unit.label}'s last order is already undone`)
  if (last.stepId === undefined) return refused('nothing_to_undo', `${unit.label}'s last order can't be undone: Undo takes back only an order that gave it a stop`)
  const firstIndex = unit.orders.findIndex(step => step.id === last.stepId)
  if (firstIndex < 0) return refused('nothing_to_undo', `${unit.label} is past the first stop of its last order`)
  const active = firstIndex === 0 && unit.orders[0]!.state === 'active'
  if (active && !underWay.includes(unit.phase)) return refused('nothing_to_undo', `${unit.label}'s last order has been carried out: it has arrived`)
  const delivery = active ? deliveryRefusal(state, unit, 0) : undefined
  if (delivery) return delivery
  const steps = unit.orders.filter(step => step.commandId === intent.commandId)
  const removal: Plan = { ok: true, routes: [], notes: [], apply: draft => removeSteps(draft, actor, unit.id, steps, true) }
  const back = last.drops
  if (back === undefined) return removal
  const removed = simulate(state, removal)
  const restore = planDoNow(removed, { taskId: back }, [{ unit: unitIn(removed, unit.id) }], actor)
  if (!restore.ok) return restore
  return {
    ok: true,
    routes: restore.routes,
    notes: restore.notes,
    apply: (draft, legs) => {
      removal.apply(draft, new Map())
      restore.apply(draft, legs)
    },
  }
}
