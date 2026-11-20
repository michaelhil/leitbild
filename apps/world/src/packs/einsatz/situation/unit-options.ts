import { capabilityRejection } from '../../../simulation/capability-rejection.ts'
import { etasFrom, turnoutFor, type TablePort } from '../eta.ts'
import { loadAfter } from '../engine/chain.ts'
import { planIntent } from '../engine/engine.ts'
import { freeInS } from '../engine/estimates.ts'
import type { EngineActor } from '../engine/intents.ts'
import { taskIn } from '../engine/draft.ts'
import { motionOf, priorityOf, unitTypeOf, type EngineState } from '../engine/model.ts'
import { isBusy } from '../engine/plan-order.ts'
import { hasLoad, isDestroyed } from '../engine/rules.ts'
import { total } from '../engine/values.ts'
import { refusal, refusalCode } from '../refusal.ts'
import type { StepTarget } from '../steps.ts'
import { heldText, targetLabel } from '../engine/chain-steps.ts'
import { plannedWarning } from '../engine/planned.ts'
import { stepKindFor } from '../steps.ts'
import { inPicture, unitAuthority, type EinsatzViewer } from '../viewer.ts'
import type { ScenarioRole } from '../../../core/model/index.ts'
import { stopPoint } from './estimates.ts'
import type { UnitOptions } from './schema.ts'
import { stopVerb } from './situation.ts'

/**
 * `world.einsatz.unit.options`: where one unit may be ordered, nearest
 * first, and where not and why. Every candidate is judged by the engine's
 * own order validation on the current state, so a target listed as valid is
 * one `world.einsatz.unit.order` accepts, unless the Run moves on meanwhile.
 * Each target has independent verdicts for starting now or adding to the
 * queue. A target the unit's plan already holds, active or queued, is
 * judged by adding it only: an order "now" to it would send the unit where
 * its plan already leads, so its replace verdict is not offered and the
 * answer says where the plan holds it. A call another unit's plan holds as
 * a later stop that already covers what this unit would add carries that
 * warning (`planned`): an order is still accepted. A busy unit names its
 * current job once, with its priority code.
 * ETAs are routed for road units in one router request, as an
 * order would route them; a target the router cannot reach is refused with
 * that refusal. Points on open ground are not listed: any may be named.
 */

const messageOf = (reason: string): string => reason.slice(refusalCode(reason).length + 2)

/** Whether two stops lead to the same task, site or track. A candidate is never a point. */
const sameObject = (a: StepTarget, b: StepTarget): boolean =>
  'taskId' in a ? 'taskId' in b && a.taskId === b.taskId
    : 'siteId' in a ? 'siteId' in b && a.siteId === b.siteId
      : 'trackId' in a && 'trackId' in b && a.trackId === b.trackId

export const readUnitOptions = async (input: {
  readonly state: EngineState
  readonly viewer: EinsatzViewer
  readonly roles: ReadonlyArray<ScenarioRole>
  readonly actor: EngineActor
  readonly unitId: string
  readonly routing: TablePort
}): Promise<UnitOptions> => {
  const { state, viewer } = input
  const unit = state.units.get(input.unitId)
  if (unit === undefined) throw capabilityRejection('capability_target_not_found', refusal('not_in_picture', 'Not in your picture'))
  const unauthorized = unitAuthority(state.catalog, viewer, input.roles, unit)
  if (unauthorized) throw capabilityRejection(unauthorized.reason.startsWith('not_in_picture') ? 'capability_target_not_found' : 'capability_input_rejected', unauthorized.reason)
  const type = unitTypeOf(state.catalog, unit)
  const busyTask = isBusy(unit) ? taskIn(state, unit.taskId!) : undefined
  const busy = busyTask === undefined ? null : { taskId: busyTask.id, label: busyTask.label, code: priorityOf(state.catalog, busyTask.priority).code, freeInS: freeInS(state, unit) ?? null }
  const plan = unit.orders.map(({ id, state }) => ({ id, state }))
  if (type.components.mobility === undefined && type.components.effector === undefined) return { unitId: unit.id, plan, busy, targets: [], refused: [] }

  const candidates: StepTarget[] = [
    ...[...state.tasks.values()].filter(task => task.closedAtMs === undefined && inPicture(state.catalog, viewer, task)).map(task => ({ taskId: task.id })),
    ...[...state.units.values()].filter(other => other.id !== unit.id && !isDestroyed(other) && unitTypeOf(state.catalog, other).components.mobility === undefined && inPicture(state.catalog, viewer, other)).map(site => ({ siteId: site.id })),
    ...(type.components.effector === undefined ? [] : [...state.combat.tracks.values()].filter(track => track.side === unit.side && track.tier === 'identified').map(track => ({ trackId: track.id }))),
  ]
  const verdict = (target: StepTarget, when: 'now' | 'after' | undefined) => planIntent(state, {
    kind: 'order', units: [unit.id], stops: [target], expectedPlan: plan,
    ...(when === undefined ? {} : { when }),
    ...(when === 'now' && busyTask !== undefined ? { drops: busyTask.id } : {}),
  }, input.actor)
  const replaceWhen = plan.length === 0 ? undefined : 'now'
  const judged = candidates.map(target => {
    const held = unit.orders.findIndex(step => sameObject(step.target, target))
    const replace = held >= 0 ? undefined : verdict(target, replaceWhen)
    // With no plan, an order to add starts immediately and has the same verdict.
    const add = plan.length === 0 && replace !== undefined ? replace : verdict(target, 'after')
    const canReplace = replace?.ok === true
    return {
      target, canReplace, add, held: held >= 0,
      replaceRefusal: replace === undefined ? heldText(state, unit, held) : replace.ok ? undefined : messageOf(replace.reason),
      refusal: canReplace || add.ok ? undefined : add.reason,
    }
  })
  const accepted = judged.filter(entry => entry.refusal === undefined)
  const from = type.components.mobility === undefined ? undefined : motionOf(state, unit.id).point
  const moving = accepted.filter(entry => !('trackId' in entry.target))
  const etas = from === undefined ? [] : await etasFrom(state, unit, from, moving.map(entry => ({ point: stopPoint(state, entry.target)!, turnoutS: turnoutFor(state, unit, 'taskId' in entry.target) })), input.routing)
  const etaOf = new Map(moving.map((entry, index) => [entry, etas[index]!]))
  const targets: Array<UnitOptions['targets'][number]> = []
  const refused: Array<UnitOptions['refused'][number]> = judged.flatMap(entry => entry.refusal === undefined ? [] : [{
    target: entry.target, label: targetLabel(state, entry.target), code: refusalCode(entry.refusal), text: messageOf(entry.refusal),
  }])
  for (const entry of accepted) {
    const eta = etaOf.get(entry)
    if (eta !== undefined && eta.kind === 'unavailable') {
      refused.push({ target: entry.target, label: targetLabel(state, entry.target), code: refusalCode(eta.reason), text: messageOf(eta.reason) })
      continue
    }
    const planned = entry.held ? undefined : 'taskId' in entry.target ? plannedWarning(state, taskIn(state, entry.target.taskId), unit) : undefined
    targets.push({
      target: entry.target,
      // Only "after" takes it: the verb is the one the stop gets once the plan is done, as the engine queues it.
      verb: stopVerb(state, unit, stepKindFor(entry.target, entry.canReplace ? hasLoad(unit) : total(loadAfter(state, unit)) > 0), entry.target),
      label: targetLabel(state, entry.target),
      afterOnly: !entry.canReplace,
      canReplace: entry.canReplace,
      canAdd: entry.add.ok,
      ...(entry.replaceRefusal === undefined ? {} : { replaceRefusal: entry.replaceRefusal }),
      ...(!entry.add.ok ? { addRefusal: messageOf(entry.add.reason) } : {}),
      ...(planned === undefined ? {} : { planned }),
      etaS: eta === undefined ? 0 : eta.seconds,
    })
  }
  targets.sort((a, b) => a.etaS - b.etaS || a.label.localeCompare(b.label, 'en', { numeric: true }))
  // Named targets do not cover open ground. Check that order separately
  // before reporting that Dispatch has nowhere to send the unit.
  const point = from === undefined || targets.length > 0 ? undefined : verdict({ point: from }, replaceWhen)
  return { unitId: unit.id, plan, busy, targets, refused, ...(point?.ok === false ? { moveRefusal: messageOf(point.reason) } : {}) }
}
