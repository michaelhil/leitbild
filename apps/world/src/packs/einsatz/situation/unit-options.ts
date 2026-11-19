import type { GeoJsonPoint, ScenarioRole } from '../../../core/model/index.ts'
import { capabilityRejection } from '../../../simulation/capability-rejection.ts'
import { etasFrom, turnoutFor, type TablePort } from '../eta.ts'
import { deliversByOrder, loadAfter } from '../engine/chain.ts'
import { nearestAcceptingSite } from '../engine/delivery.ts'
import { planIntent } from '../engine/engine.ts'
import { freeInS, stopDoneInS } from '../engine/estimates.ts'
import type { EngineActor } from '../engine/intents.ts'
import { taskIn } from '../engine/draft.ts'
import { motionOf, priorityOf, unitTypeOf, type EngineState, type UnitRecord } from '../engine/model.ts'
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
 * delivered. ETAs are routed for road units as an order would route them, a
 * target an order takes now in one router request from where the unit is;
 * a target only "after" takes from where and when its plan ends
 * (`planEnd`). A target the router cannot reach is refused with that
 * refusal. Points on open ground are not listed: any may be named.
 */

const messageOf = (reason: string): string => reason.slice(refusalCode(reason).length + 2)

/** Seconds a unit spends handing its load over at a site. */
const handoverAt = (state: EngineState, siteId: string): number => {
  const receiving = unitTypeOf(state.catalog, state.units.get(siteId)!).components.receiving
  if (receiving === undefined) throw new Error(`${siteId} takes no delivery`)
  return receiving.handoverS
}

type PlanEnd = { readonly point: GeoJsonPoint; readonly inS: number } | { readonly reason: string }

/**
 * Where a stop given "after" a unit's plan starts, and in how many seconds:
 * once its active stop is done (`stopDoneInS`, with the handover of a
 * delivery not yet handing over), then each queued stop in turn, with a
 * task's turnout and time on task and a delivery's handover; and the
 * deliveries its deliver standing order makes, before any stop it cannot
 * take loaded and after the plan, to the nearest accepting site, as the
 * engine resolves them (`nearestAcceptingSite`). Each leg is timed as an
 * order would time it now (`etasFrom`); a leg that cannot be timed gives its
 * reason.
 */
const planEnd = async (state: EngineState, unit: UnitRecord, routing: TablePort): Promise<PlanEnd> => {
  const type = unitTypeOf(state.catalog, unit)
  const mobilizeS = type.components.mobility!.mobilizeS
  const onSceneS = type.components.service?.onSceneS ?? 0
  const delivers = deliversByOrder(state, unit)
  let point = motionOf(state, unit.id).point
  let inS = 0
  const head = unit.orders[0]
  const first = head?.state === 'active' ? 1 : 0
  if (head !== undefined && first === 1) {
    const done = stopDoneInS(state, unit)
    if (done === undefined) return { reason: refusal('routing_unavailable', `${unit.label} is stopped`) }
    const handingOver = unit.phase === 'at-site' && unit.phaseDueMs !== undefined
    inS = done + ('siteId' in head.target && hasLoad(unit) && !handingOver ? handoverAt(state, head.target.siteId) : 0)
    point = stopPoint(state, head.target) ?? point
  }
  /** Travels to `to` after `turnoutS`; the reason when the leg cannot be timed. */
  const travel = async (to: GeoJsonPoint, turnoutS: number): Promise<string | undefined> => {
    const eta = (await etasFrom(state, unit, point, [{ point: to, turnoutS }], routing))[0]!
    if (eta.kind === 'unavailable') return eta.reason
    inS += eta.seconds
    point = to
    return undefined
  }
  /** The deliver order's delivery of what the unit holds once its first `count` stops are done. */
  const deliverAfter = async (count: number): Promise<string | undefined> => {
    const load = loadAfter(state, unit, count)
    if (!delivers || total(load) === 0) return undefined
    const site = nearestAcceptingSite(state, unit, point, load)
    if (site === undefined) return refusal('site_not_accepting', `No site accepts what ${unit.label} will carry`)
    const failed = await travel(motionOf(state, site.id).point, 0)
    inS += handoverAt(state, site.id)
    return failed
  }
  for (let index = first; index < unit.orders.length; index++) {
    const step = unit.orders[index]!
    const target = step.target
    if (!('siteId' in target)) {
      const failed = await deliverAfter(index)
      if (failed !== undefined) return { reason: failed }
    }
    const to = stopPoint(state, target)
    const failed = to === undefined ? undefined : await travel(to, 'taskId' in target ? mobilizeS : 0)
    if (failed !== undefined) return { reason: failed }
    if ('taskId' in target) inS += onSceneS
    if ('siteId' in target && total(loadAfter(state, unit, index)) > 0) inS += handoverAt(state, target.siteId)
  }
  const failed = await deliverAfter(unit.orders.length)
  return failed === undefined ? { point, inS } : { reason: failed }
}

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
    await timed(accepted.filter(entry => entry.now), motionOf(state, unit.id).point, target => turnoutFor(state, unit, 'taskId' in target), 0)
    const later = accepted.filter(entry => !entry.now)
    if (later.length > 0) {
      const end = await planEnd(state, unit, input.routing)
      if ('reason' in end) for (const entry of later) refuse(entry.target, end.reason)
      // The unit stands at the end of its plan, so a task takes its full turnout.
      else await timed(later, end.point, target => 'taskId' in target ? type.components.mobility!.mobilizeS : 0, end.inS)
    }
  }
  targets.sort((a, b) => a.etaS - b.etaS || a.label.localeCompare(b.label, 'en', { numeric: true }))
  return { unitId: unit.id, busy, targets, refused }
}
