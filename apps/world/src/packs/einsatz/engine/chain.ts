import { refusalCode } from '../refusal.ts'
import type { PlanExpectation } from '../order-schema.ts'
import { maxSteps, stepKindFor, stepTargetId, type Step, type StepKind, type StepTarget } from '../steps.ts'
import { clearedByOrder, heldText, newStep, skipSteps, targetLabel } from './chain-steps.ts'
import { assignedTo, contributionOf, loadAllocation } from './coverage.ts'
import { putUnit, setMotion, unitIn, type Draft } from './draft.ts'
import { engageRefusal } from './engagement-orders.ts'
import { actionBy, immobile, loadedText, notInPicture, refused, type Refused } from './intent-support.ts'
import type { EngineActor, IntentOf, Plan } from './intents.ts'
import { clearAlerts, unitTypeOf, type EngineState, type LastAction, type TaskRecord, type UnitRecord } from './model.ts'
import { planDoNow, planStart, resolveTarget, siteRefusal, type Target } from './orders.ts'
import { releaseFromTask } from './phases.ts'
import { hasLoad, linksToTask } from './rules.ts'
import { countOf, countsOf, patch, total, type Counts } from './values.ts'
import { loadText } from './wording.ts'

/**
 * Plans: adding a stop at the end, removing one, and the engine starting the
 * next stop once the active one is done. Every change is a transition of the
 * unit; motion is not. Only the active stop counts towards a task's
 * coverage; later stops count only where someone decides who else to send
 * (`planned.ts`).
 */

const orderOn = (draft: Draft, actor: EngineActor, verb: LastAction['verb'], step?: Step): LastAction => ({
  ...actionBy(draft, actor, verb, step === undefined ? undefined : stepTargetId(step.target)),
  ...(step === undefined ? {} : { stepId: step.id }),
})

/** What a unit's carry takes from a task's waiting load, most urgent class first, up to its free capacity. */
const withPickup = (state: EngineState, unit: UnitRecord, load: Counts, taskId: string): Counts => {
  const carry = unitTypeOf(state.catalog, unit).components.carry
  const task = state.tasks.get(taskId)
  if (carry === undefined || task === undefined) return load
  let room = carry.capacity - total(load)
  return countsOf(state.catalog.classIds.map(classId => {
    const take = carry.classes.includes(classId) ? Math.max(0, Math.min(room, countOf(task.loads, classId))) : 0
    room -= take
    return [classId, countOf(load, classId) + take] as const
  }))
}

/** A unit whose deliver order takes its load to the nearest accepting site before any other step. */
export const deliversByOrder = (state: EngineState, unit: UnitRecord): boolean => unitTypeOf(state.catalog, unit).standingOrders?.deliver === 'nearest-accepting'

/**
 * What a unit will carry once it has carried out its first `count` steps,
 * all of them by default: a step to a site delivers what it carries, a
 * deliver order delivers before any other step, and a task fills its free
 * capacity with waiting load it can carry. It reads waiting load as it
 * stands now.
 */
export const loadAfter = (state: EngineState, unit: UnitRecord, count = unit.orders.length): Counts => {
  const delivers = deliversByOrder(state, unit)
  let load: Counts = unit.load
  for (const step of unit.orders.slice(0, count)) {
    if ('siteId' in step.target && total(load) > 0) {
      load = {}
      continue
    }
    if (delivers) load = {}
    if ('taskId' in step.target) load = withPickup(state, unit, load, step.target.taskId)
  }
  return load
}

/**
 * Whether a unit that already holds a task leaves waiting load there for
 * one more trip: what it can carry of the task's waiting load, beyond what
 * the units on the task take and what its own queued trips there will take.
 */
const loadLeftFor = (state: EngineState, unit: UnitRecord, task: TaskRecord, trips: number): boolean => {
  const carry = unitTypeOf(state.catalog, unit).components.carry
  if (carry === undefined) return false
  const carried = (counts: Counts): number => carry.classes.reduce((sum, classId) => sum + countOf(counts, classId), 0)
  const taken = [...loadAllocation(state.catalog, task, assignedTo(state.units.values(), task)).values()].reduce((sum, share) => sum + carried(share), 0)
  const queuedTrips = trips - (unit.taskId === task.id ? 1 : 0)
  return carried(task.loads) - taken - queuedTrips * carry.capacity > 0
}

/** Why a step for this target cannot join the end of the unit's chain, judged on what the unit will carry by then and on the task's coverage now. */
const queueRefusal = (state: EngineState, unit: UnitRecord, target: Target, load: Counts, kind: StepKind): Refused | undefined => {
  // A task the chain already holds is taken again only as a further trip for load still waiting; otherwise the answer is where the plan holds it, whatever the unit will carry by then.
  const trips = target.kind === 'task' ? unit.orders.filter(step => 'taskId' in step.target && step.target.taskId === target.task.id).length : 0
  if (target.kind === 'task' && trips > 0 && !loadLeftFor(state, unit, target.task, trips)) {
    // Named by its latest trip there, the one a further trip would follow.
    const latest = unit.orders.reduce((found, step, index) => 'taskId' in step.target && step.target.taskId === target.task.id ? index : found, -1)
    return refused('already_in_plan', heldText(state, unit, latest))
  }
  if (kind !== 'deliver' && total(load) > 0 && !deliversByOrder(state, unit)) {
    return refused('unit_loaded', `${unit.label} will have ${loadText(state.catalog, load)} on board by then; add a delivery stop first`)
  }
  if (target.kind === 'track') return engageRefusal(state, unit, target.track)
  const cannotMove = immobile(state, unit)
  if (cannotMove) return cannotMove
  if (target.kind === 'site') return siteRefusal(state, unit, target.site, kind === 'deliver' ? load : {})
  if (target.kind !== 'task') return undefined
  const task = target.task
  if (!linksToTask(unit, task)) return refused('cross_side_reference', `${unit.label} cannot serve another side's ${task.label}`)
  // A further trip for load still waiting there.
  if (trips > 0) return undefined
  // By then the unit carries nothing and serves no other task.
  const free = patch(unit, { load: {}, taskId: undefined })
  const contribution = contributionOf(state.catalog, task, assignedTo(state.units.values(), task), free)
  if (contribution.adds) return undefined
  if (contribution.unmet[0] !== undefined) return refused('requirement_unmet', contribution.unmet[0])
  if (contribution.covered) return refused('requirement_covered', `${task.label} needs nothing more than ${unit.label} provides`)
  return refused('requirement_unmet', `${unit.label} provides nothing ${task.label} needs`)
}

/**
 * Add a stop at the end of a unit's plan. A unit holding no step starts it
 * at once, exactly as a do-now order. Otherwise the stop is judged as the
 * unit will stand when it comes up: its load then (a capacity it cannot use
 * before delivering is refused), its side, and the task's coverage now.
 * Queued, it counts towards nothing.
 */
export const planAppend = (state: EngineState, unitId: string, to: StepTarget, actor: EngineActor): Plan => {
  const unit = state.units.get(unitId)
  if (unit === undefined) return notInPicture()
  if (unit.orders.length === 0) return planDoNow(state, to, [{ unit }], actor)
  if (unit.orders.length >= maxSteps) return refused('chain_full', `${unit.label} already holds ${unit.orders.length} stops; remove one first`)
  const target = resolveTarget(state, to)
  if ('ok' in target) return target
  const load = loadAfter(state, unit)
  const loaded = total(load) > 0
  const refusal = queueRefusal(state, unit, target, load, stepKindFor(to, loaded))
  if (refusal) return refusal
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      const current = unitIn(draft, unit.id)
      const { step, stepSerial } = newStep(current, to, loaded, 'queued', actor)
      putUnit(draft, patch(current, { orders: [...current.orders, step], stepSerial, alerts: clearAlerts(current.alerts, clearedByOrder(actor)), lastAction: orderOn(draft, actor, 'queue', step) }))
    },
  }
}

/**
 * Why the step at `index` may not leave the chain: it leads to a site and
 * delivers what the unit will carry there. The load the unit carries now
 * keeps its first site step; load it will pick up on the way keeps the step
 * unless its deliver order would deliver that load anyway.
 */
export const deliveryRefusal = (state: EngineState, unit: UnitRecord, index: number): Refused | undefined => {
  if (!('siteId' in unit.orders[index]!.target)) return undefined
  if (hasLoad(unit) && unit.orders.findIndex(entry => 'siteId' in entry.target) === index) return refused('unit_loaded', loadedText(state, unit))
  const load = loadAfter(state, unit, index)
  if (total(load) === 0 || deliversByOrder(state, unit)) return undefined
  return refused('unit_loaded', `${unit.label} will have ${loadText(state.catalog, load)} on board by then; that step delivers it`)
}

export const changedPlan = (unit: UnitRecord, expectedPlan: PlanExpectation): Refused | undefined => {
  if (unit.orders.length === expectedPlan.length && unit.orders.every((step, index) => {
    const expected = expectedPlan[index]!
    return step.id === expected.id && step.state === expected.state
  })) return undefined
  return refused('plan_changed', `${unit.label}’s plan changed. Review its current stops and try again`)
}

/**
 * Remove one stop. A queued stop simply leaves. The active stop is released
 * as a recall releases it: a task gets its work back, the unit stops where
 * it is and starts its next stop, or, with none, its return order applies.
 * A unit keeps the stop that delivers the load it carries, or will carry,
 * there (see `deliveryRefusal`).
 */
export const planStopRemove = (state: EngineState, intent: IntentOf<'stop.remove'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  const changed = intent.expectedPlan === undefined ? undefined : changedPlan(unit, intent.expectedPlan)
  if (changed) return changed
  const index = unit.orders.findIndex(step => step.id === intent.stopId)
  if (index < 0) return refused('step_not_found', `${unit.label} holds no stop ${intent.stopId}`)
  const delivery = deliveryRefusal(state, unit, index)
  if (delivery) return delivery
  return { ok: true, routes: [], notes: [], apply: draft => removeSteps(draft, actor, unit.id, [unit.orders[index]!], false) }
}

/**
 * Removes steps from a unit's plan as one order. A released active step
 * stops the unit where it is; quietly (an undo) its task's work never left
 * it, so no work-returned alert is raised and the order records `undo`.
 */
export const removeSteps = (draft: Draft, actor: EngineActor, unitId: string, steps: ReadonlyArray<Step>, quietly: boolean): void => {
  const current = unitIn(draft, unitId)
  const ids = new Set(steps.map(step => step.id))
  const order: LastAction = quietly
    ? actionBy(draft, actor, 'undo')
    : { ...actionBy(draft, actor, 'remove', stepTargetId(steps[0]!.target)), stepId: steps[0]!.id }
  const orders = current.orders.filter(entry => !ids.has(entry.id))
  const alerts = clearAlerts(current.alerts, clearedByOrder(actor))
  const command = actor.commandId === undefined ? {} : { lastCommand: { id: actor.commandId, ...(quietly ? { undo: true as const } : {}) } }
  const head = current.orders[0]
  if (head === undefined || head.state !== 'active' || !ids.has(head.id)) {
    putUnit(draft, patch(current, { orders, alerts, lastAction: order, ...command }))
    return
  }
  if ('trackId' in head.target) {
    putUnit(draft, patch(current, { orders, alerts, lastAction: order, ...command, engage: current.engage === head.target.trackId ? undefined : current.engage }))
    return
  }
  const released = releaseFromTask(draft, current, order, quietly)
  setMotion(draft, unitId, { progressMs: 0 })
  putUnit(draft, patch(released, { orders, alerts, lastAction: order, ...command, leg: undefined, siteId: undefined, phase: 'available', phaseSinceMs: draft.timeMs, phaseDueMs: undefined }))
}

/** The message of a refusal, without its code. */
const messageOf = (reason: string): string => reason.slice(refusalCode(reason).length + 2)

/** Skips a unit's queued first step, naming why; the chain goes on with the next one. */
export const skipHead = (draft: Draft, unitId: string, head: Step, reason: string): void => {
  const current = unitIn(draft, unitId)
  putUnit(draft, skipSteps(current, draft.timeMs, step => step.id === head.id ? { label: targetLabel(draft, step.target), reason: messageOf(reason) } : undefined))
}

/**
 * Starts an idle unit's queued first step as a do-now order would, keeping its id:
 * the same checks, then the route. A step that can no longer be carried out
 * (its task covered or closed, its site not accepting, its track no longer
 * engageable, or one the unit cannot take while it carries load) is skipped
 * under an alert, and the next one comes up.
 */
export const planChainNext = (state: EngineState, intent: IntentOf<'chain.next'>, actor: EngineActor): Plan => {
  const unit = unitIn(state, intent.unitId)
  const head = unit.orders[0]
  if (head === undefined || head.state !== 'queued') throw new Error(`${unit.id}: no queued step to start`)
  const skip = (reason: string): Plan => ({ ok: true, routes: [], notes: [], apply: draft => skipHead(draft, unit.id, head, reason) })
  if (hasLoad(unit) && !('siteId' in head.target)) return skip(refused('unit_loaded', loadedText(state, unit)).reason)
  const plan = planStart(state, head.target, [{ unit }], [], actor, { kind: 'next', step: head })
  return plan.ok ? plan : skip(plan.reason)
}
