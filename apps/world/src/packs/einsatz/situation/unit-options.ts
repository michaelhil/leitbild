import { capabilityRejection } from '../../../simulation/capability-rejection.ts'
import { etasFrom, turnoutFor, type TablePort } from '../eta.ts'
import { planIntent } from '../engine/engine.ts'
import { freeInS } from '../engine/estimates.ts'
import type { EngineActor } from '../engine/intents.ts'
import { taskIn } from '../engine/draft.ts'
import { motionOf, priorityOf, unitTypeOf, type EngineState } from '../engine/model.ts'
import { isBusy } from '../engine/plan-order.ts'
import { hasLoad, isDestroyed } from '../engine/rules.ts'
import { refusal, refusalCode } from '../refusal.ts'
import type { StepTarget } from '../steps.ts'
import { targetLabel } from '../engine/chain-steps.ts'
import { stepKindFor } from '../steps.ts'
import { inPicture, unitAuthority, type EinsatzViewer } from '../viewer.ts'
import type { ScenarioRole } from '../../../core/model/index.ts'
import { stopPoint } from './estimates.ts'
import type { UnitOptions } from './schema.ts'
import { stopVerb } from './situation.ts'

/**
 * `world.einsatz.unit.options`: where one unit may be ordered now, nearest
 * first, and where not and why. Every candidate is judged by the engine's
 * own order validation on the current state, so a target listed as valid is
 * one `world.einsatz.unit.order` accepts, unless the Run moves on meanwhile.
 * A busy unit's target is valid when an order "after" its current job or
 * "now", dropping its task, would be accepted; `drops` is set where "now"
 * would be. ETAs are routed for road units in one router request, as an
 * order would route them; a target the router cannot reach is refused with
 * that refusal. Points on open ground are not listed: any may be named.
 */

const messageOf = (reason: string): string => reason.slice(refusalCode(reason).length + 2)

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
  const busy = busyTask === undefined ? null : { taskId: busyTask.id, label: busyTask.label, freeInS: freeInS(state, unit) ?? null }
  if (type.components.mobility === undefined && type.components.effector === undefined) return { unitId: unit.id, busy, targets: [], refused: [] }

  const candidates: StepTarget[] = [
    ...[...state.tasks.values()].filter(task => task.closedAtMs === undefined && inPicture(state.catalog, viewer, task)).map(task => ({ taskId: task.id })),
    ...[...state.units.values()].filter(other => other.id !== unit.id && !isDestroyed(other) && unitTypeOf(state.catalog, other).components.mobility === undefined && inPicture(state.catalog, viewer, other)).map(site => ({ siteId: site.id })),
    ...(type.components.effector === undefined ? [] : [...state.combat.tracks.values()].filter(track => track.side === unit.side && track.tier === 'identified').map(track => ({ trackId: track.id }))),
  ]
  const judged = candidates.map(target => {
    const verdict = (when: 'now' | 'after' | undefined) => planIntent(state, {
      kind: 'order', units: [unit.id], stops: [target],
      ...(when === undefined ? {} : { when }),
      ...(when === 'now' && busyTask !== undefined ? { drops: busyTask.id } : {}),
    }, input.actor)
    if (busyTask === undefined) {
      const plan = verdict(undefined)
      return { target, now: plan.ok, refusal: plan.ok ? undefined : plan.reason }
    }
    const now = verdict('now')
    const after = verdict('after')
    return { target, now: now.ok, refusal: now.ok ? undefined : after.ok ? undefined : after.reason }
  })
  const accepted = judged.filter(entry => entry.refusal === undefined)
  const from = type.components.mobility === undefined ? undefined : motionOf(state, unit.id).point
  const moving = accepted.filter(entry => !('trackId' in entry.target))
  const etas = from === undefined ? [] : await etasFrom(state, unit, from, moving.map(entry => ({ point: stopPoint(state, entry.target)!, turnoutS: turnoutFor(state, unit, 'taskId' in entry.target) })), input.routing)
  const etaOf = new Map(moving.map((entry, index) => [entry, etas[index]!]))
  const drops = busyTask === undefined ? undefined : { taskId: busyTask.id, label: busyTask.label, code: priorityOf(state.catalog, busyTask.priority).code }
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
    targets.push({
      target: entry.target,
      verb: stopVerb(state, unit, stepKindFor(entry.target, hasLoad(unit)), entry.target),
      label: targetLabel(state, entry.target),
      etaS: eta === undefined ? 0 : eta.seconds,
      ...(entry.now && drops !== undefined ? { drops } : {}),
    })
  }
  targets.sort((a, b) => a.etaS - b.etaS || a.label.localeCompare(b.label, 'en', { numeric: true }))
  return { unitId: unit.id, busy, targets, refused }
}
