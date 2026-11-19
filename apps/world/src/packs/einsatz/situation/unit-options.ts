import type { GeoJsonPoint, ScenarioRole } from '../../../core/model/index.ts'
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
import { targetLabel } from '../engine/chain-steps.ts'
import { stepKindFor } from '../steps.ts'
import { inPicture, unitAuthority, type EinsatzViewer } from '../viewer.ts'
import { stopPoint } from './estimates.ts'
import type { UnitOptions } from './schema.ts'
import { stopVerb } from './situation.ts'

/**
 * `world.einsatz.unit.options`: where one unit may be ordered now, nearest
 * first, and where not and why. Every candidate is judged by the engine's
 * own order validation on the current state, so a target listed as valid is
 * one `world.einsatz.unit.order` accepts, unless the Run moves on meanwhile.
 * A busy unit names its current job once (`busy`, with the task's priority
 * code). Each valid target says whether an order now takes it (`now`): for a
 * busy unit one with `when: 'now'`, dropping that job, for any other one
 * without `when`. A target only an order "after" takes (`now: false`) is
 * valid too: a busy unit's next job, or a loaded carrier's call once it has
 * delivered. ETAs are routed for road units in one router request, as an
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
  const busy = busyTask === undefined ? null : { taskId: busyTask.id, label: busyTask.label, code: priorityOf(state.catalog, busyTask.priority).code, freeInS: freeInS(state, unit) ?? null }
  if (type.components.mobility === undefined && type.components.effector === undefined) return { unitId: unit.id, busy, targets: [], refused: [] }

  const candidates: StepTarget[] = [
    ...[...state.tasks.values()].filter(task => task.closedAtMs === undefined && inPicture(state.catalog, viewer, task)).map(task => ({ taskId: task.id })),
    ...[...state.units.values()].filter(other => other.id !== unit.id && !isDestroyed(other) && unitTypeOf(state.catalog, other).components.mobility === undefined && inPicture(state.catalog, viewer, other)).map(site => ({ siteId: site.id })),
    ...(type.components.effector === undefined ? [] : [...state.combat.tracks.values()].filter(track => track.side === unit.side && track.tier === 'identified').map(track => ({ trackId: track.id }))),
  ]
  type Judged = { readonly target: StepTarget; readonly now: boolean } | { readonly target: StepTarget; readonly refusal: string }
  const judged = candidates.map((target): Judged => {
    const verdict = (when: 'now' | 'after' | undefined) => planIntent(state, {
      kind: 'order', units: [unit.id], stops: [target],
      ...(when === undefined ? {} : { when }),
      ...(when === 'now' && busyTask !== undefined ? { drops: busyTask.id } : {}),
    }, input.actor)
    if (busyTask !== undefined) {
      if (verdict('now').ok) return { target, now: true }
    } else {
      const plain = verdict(undefined)
      if (plain.ok) return { target, now: true }
      // With no plan, an order "after" starts at once, as one without `when`.
      if (unit.orders.length === 0) return { target, refusal: plain.reason }
    }
    const after = verdict('after')
    return after.ok ? { target, now: false } : { target, refusal: after.reason }
  })
  const refused: Array<UnitOptions['refused'][number]> = []
  const refuse = (target: StepTarget, reason: string): void => {
    refused.push({ target, label: targetLabel(state, target), code: refusalCode(reason), text: messageOf(reason) })
  }
  for (const entry of judged) if ('refusal' in entry) refuse(entry.target, entry.refusal)
  const accepted = judged.flatMap(entry => 'now' in entry ? [entry] : [])
  const targets: Array<UnitOptions['targets'][number]> = []
  const listed = (entry: { readonly target: StepTarget; readonly now: boolean }, etaS: number): void => {
    // Only "after" takes it: the verb is the one the stop gets once the plan is done, as the engine queues it.
    const loaded = entry.now ? hasLoad(unit) : total(loadAfter(state, unit)) > 0
    targets.push({ target: entry.target, verb: stopVerb(state, unit, stepKindFor(entry.target, loaded), entry.target), label: targetLabel(state, entry.target), etaS, now: entry.now })
  }
  const timed = async (entries: ReadonlyArray<{ readonly target: StepTarget; readonly now: boolean }>, from: GeoJsonPoint, turnoutS: (target: StepTarget) => number, offsetS: number): Promise<void> => {
    const moving = entries.filter(entry => !('trackId' in entry.target))
    const etas = await etasFrom(state, unit, from, moving.map(entry => ({ point: stopPoint(state, entry.target)!, turnoutS: turnoutS(entry.target) })), input.routing)
    const etaOf = new Map(moving.map((entry, index) => [entry, etas[index]!]))
    for (const entry of entries) {
      const eta = etaOf.get(entry)
      if (eta !== undefined && eta.kind === 'unavailable') refuse(entry.target, eta.reason)
      else listed(entry, offsetS + (eta === undefined ? 0 : eta.seconds))
    }
  }
  if (type.components.mobility === undefined) {
    for (const entry of accepted) listed(entry, 0)
  } else {
    await timed(accepted, motionOf(state, unit.id).point, target => turnoutFor(state, unit, 'taskId' in target), 0)
  }
  targets.sort((a, b) => a.etaS - b.etaS || a.label.localeCompare(b.label, 'en', { numeric: true }))
  return { unitId: unit.id, busy, targets, refused }
}
