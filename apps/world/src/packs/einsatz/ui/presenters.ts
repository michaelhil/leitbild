import { z } from 'zod'
import { objectIdSchema, type OperationalObject } from '../../../core/model/index.ts'
import { einsatzPackId } from '../ids.ts'
import { neutralLexicon, unitPhases } from '../lexicon.ts'
import type { Stop, UnitOrderInput } from '../order-schema.ts'
import type { Eta, RecommendAnswer } from '../recommendation-schema.ts'
import type { Situation, SituationCall, SituationSite, SituationUnit, StopVerb, UnitOptions, UnitTone } from '../situation/schema.ts'
import { clockText, contactIcon } from '../text.ts'
import { mapTargetingMaxTags, type MapTargeting } from '../../../ui/surface-panel-interaction.ts'
import { canTarget, matchingOptions, selectedObjectOf, stopKey, stopObjectId, type CurrentJob, type DispatchObjectKind, type Selection } from './selection.ts'

/**
 * What the Dispatch panel shows, as plain view models over the Run's own
 * read models: `world.einsatz.situation` for the lists and cards,
 * `world.einsatz.unit.options` for the selected unit and the call card's pinned
 * `world.einsatz.recommend`. The panel never holds the configuration: every
 * word here is the situation's (its lexicon words, labels, codes and
 * nouns), apart from the neutral mechanism words of the controls themselves.
 * Sections and columns follow `situation.features`, so a configuration with
 * no carriers shows no load column, one with no receiving type no sites and
 * one with no sensor or effector no contacts.
 *
 * Times the situation gives at the moment it was read (`waitingS`, ETAs,
 * `phaseDueInS`) run on by `elapsedS`, the Run seconds since that read, so
 * the panel's clocks follow the Run clock between reads.
 */

/** How long a receipt of this screen's own order offers Undo. The card's "Undo last order" stays until the engine refuses it. */
export const receiptUndoMs = 8_000
/** The most receipts the footer keeps, newest on top. */
export const maxReceipts = 3

/** Mechanism words of the controls; every domain word comes from the situation. */
export const dispatchWords = {
  panel: 'Dispatch',
  loading: 'Loading…',
  readFailed: 'Could not read the situation',
  retry: 'Retry',
  close: 'Close',
  newBadge: 'New',
  waiting: 'Waiting',
  overdue: 'Overdue',
  undo: 'Undo',
  undoLast: 'Undo last order',
  nothingToUndo: 'No order to undo',
  deliverTo: 'Deliver to',
  refresh: 'Refresh suggestion',
  whyNot: 'Why not others?',
  free: 'free',
  oldest: 'oldest',
  open: 'open',
  confirm: 'Confirm',
  cancel: 'Cancel',
  noFreeUnit: 'No free unit can help',
  covered: 'Every need is covered',
  noUnitChosen: 'No unit chosen',
  closed: 'Closed',
  notListed: 'Not in the situation any more',
  closeArrivals: 'Close for arrivals',
  openArrivals: 'Open for arrivals',
  accepting: 'Accepting',
  notAccepting: 'Closed for arrivals',
  inbound: 'Inbound',
  slots: 'slots in use',
  validTargets: 'Targets',
  loadingTargets: 'Reading targets…',
  refreshing: 'Reading the suggestion again…',
  suggestionHolds: 'The suggestion still holds',
  observedBy: 'Observed by',
  mapPoint: 'the map point',
} as const

/** Seconds as whole minutes, at least one. */
export const minutesText = (seconds: number): string => `${Math.max(1, Math.round(Math.max(0, seconds) / 60))} min`

/**
 * A refusal's message without its `<code>: ` prefix; any other text as it
 * is. The one place a refusal's reason is read: the code itself is only
 * ever taken from the result's own `code`, never from this text.
 */
export const refusalText = (reason: string): string => /^[a-z][a-z0-9_]*: (.+)$/s.exec(reason)?.[1] ?? reason

/** An ETA, run on by `elapsedS`; an unavailable one says why. */
export const etaText = (eta: Eta | null, elapsedS = 0): string | null => {
  if (eta === null) return null
  if (eta.kind === 'unavailable') return refusalText(eta.reason)
  return minutesText(eta.seconds - elapsedS)
}

const etaSeconds = (eta: Eta | null): number | null => eta === null || eta.kind === 'unavailable' ? null : eta.seconds

type Words = Situation['words']

/** The verb of a stop, in the situation's words where the lexicon has one. */
export const verbText = (verb: StopVerb, words: Words): string => {
  switch (verb) {
    case 'serve': return words.send
    case 'pick-up': return 'Pick up at'
    case 'deliver': return dispatchWords.deliverTo
    case 'go-to': return words.move
    case 'engage': return 'Engage'
  }
}

const joined = (labels: ReadonlyArray<string>): string => labels.join(', ')

export interface ButtonView {
  readonly label: string
  readonly enabled: boolean
  /** Why it is disabled; null while enabled. */
  readonly reason: string | null
}

const button = (label: string, reason: string | null): ButtonView => ({ label, enabled: reason === null, reason })

// ——— Einsatz object records ———

const presentationSchema = z.object({ icon: z.string().min(1), typeLabel: z.string().min(1) }).strict()
const trackTiers = ['contact', 'identified', 'destroyed'] as const
export type TrackTier = typeof trackTiers[number]

/**
 * The record an Einsatz object carries in its `packData`, as the browser
 * reads it: the one schema the map presentation (`ui-pack.ts`), the
 * selection table and the Contacts section parse it with. A unit's and a
 * task's record carry more than the browser reads; a track's and a track
 * index's carry exactly this.
 */
export const einsatzRecordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('unit'),
    presentation: presentationSchema,
    phase: z.enum(unitPhases),
    integrity: z.enum(['healthy', 'damaged', 'destroyed']),
    taskId: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
    load: z.record(z.string(), z.number()),
    /** Present on a receiving site only. */
    accepting: z.boolean().optional(),
  }).loose(),
  z.object({ type: z.literal('task'), presentation: presentationSchema }).loose(),
  z.object({
    type: z.literal('track'),
    tier: z.enum(trackTiers),
    fix: z.boolean(),
    identity: z.object({ typeLabel: z.string().min(1), icon: z.string().min(1), side: z.string().min(1), rangeM: z.number().positive().optional() }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal('track-index'), side: z.string().min(1), next: z.number().int().positive(), subjects: z.record(z.string(), z.string()) }).strict(),
])
export type EinsatzRecord = z.output<typeof einsatzRecordSchema>

/** The record of an Einsatz object; one that does not match is refused loudly. */
export const einsatzRecordOf = (object: Pick<OperationalObject, 'packData'>): EinsatzRecord => einsatzRecordSchema.parse(object.packData)

/**
 * What an object is to the panel, as `world.einsatz.situation` lists it: a
 * unit whose type moves (a core `mobile_entity`) is a unit, any other unit
 * record a site, a place units go to whether it receives load or not (a
 * core `facility`); a task is a call, a track a track; a track index, and
 * another Pack's object, none of them.
 */
export const dispatchKindOf = (object: Pick<OperationalObject, 'packId' | 'packData' | 'kind'>): DispatchObjectKind | null => {
  if (object.packId !== einsatzPackId) return null
  const record = einsatzRecordOf(object)
  switch (record.type) {
    case 'unit': return object.kind === 'facility' ? 'site' : 'unit'
    case 'task': return 'call'
    case 'track': return 'track'
    case 'track-index': return null
  }
}

/** A track's tier in the neutral words. */
export const tierWord = (tier: TrackTier): string => {
  switch (tier) {
    case 'contact': return neutralLexicon.contact
    case 'identified': return neutralLexicon.identified
    case 'destroyed': return neutralLexicon.destroyed
  }
}

/** How long ago a track was last detected, as m:ss at `nowMs`; null while the time or the detection is unknown. */
export const trackAgeText = (object: Pick<OperationalObject, 'spatial'>, nowMs: number | null): string | null => {
  const observedAt = object.spatial.position?.observedAt
  return nowMs === null || observedAt === undefined ? null : clockText((nowMs - Date.parse(observedAt)) / 1_000)
}

/**
 * When the panel reads the situation again: the Einsatz records the
 * screen's own projection holds, as a key that changes whenever the Run
 * commits a change to one (a call made, served or closed, an order, a phase,
 * a site opened or closed) and never for movement alone, which the panel's
 * clocks carry between reads. Einsatz announces no Pack data revision (its
 * runtime emits no `pack.data.changed`, and a side view hears none), so
 * this is the panel's data revision; built from what the screen already
 * sees, it tells a side nothing it could not see.
 */
export const einsatzRecordsKey = (objects: ReadonlyArray<Pick<OperationalObject, 'id' | 'packId' | 'lifecycle' | 'packData'>>): string =>
  JSON.stringify(objects.flatMap(object => object.packId === einsatzPackId ? [[object.id, object.lifecycle, object.packData]] : []))

// ——— Unit card ———

export interface PlanStopView {
  readonly id: string
  readonly index: number
  readonly text: string
  readonly eta: string | null
  readonly active: boolean
  readonly by: string | null
  readonly removeLabel: string
  readonly canMoveUp: boolean
  readonly canMoveDown: boolean
}

export interface UnitCardView {
  readonly kind: 'unit'
  readonly id: string
  readonly icon: string
  readonly title: string
  readonly status: { readonly word: string; readonly tone: UnitTone; readonly due: string | null }
  readonly readOnly: string | null
  readonly recall: ButtonView
  /**
   * "Undo last order (by Assistant: C-2 → Depot B)": who gave the order it
   * takes back and where it sent the unit. Disabled with a reason while the
   * situation names no command to take back, and with the engine's own
   * refusal once the engine refused to take back this command.
   */
  readonly undo: ButtonView & { readonly commandId: string | null }
  readonly planHeading: string
  readonly plan: ReadonlyArray<PlanStopView>
  readonly removable: boolean
  readonly predicted: string | null
  readonly facts: ReadonlyArray<string>
  readonly states: ReadonlyArray<string>
  readonly targets: ReadonlyArray<{ readonly key: string; readonly target: Stop; readonly text: string; readonly eta: string | null }>
  readonly targetsLoading: boolean
  readonly targetNotice: string | null
}

const taskStopLabels = (unit: SituationUnit): ReadonlyArray<string> => unit.plan.filter(stop => 'taskId' in stop.target).map(stop => stop.label)
const loadLabels = (unit: SituationUnit): ReadonlyArray<string> => unit.carry?.load.filter(entry => entry.count > 0).map(entry => entry.label) ?? []
const dueText = (unit: SituationUnit, elapsedS: number): string | null => unit.phaseDueInS === null ? null : clockText(unit.phaseDueInS - elapsedS)
export const jobText = (job: CurrentJob): string => `${job.label} · ${job.code}`

/** The engine's refusal to take back a unit's command, kept against that command: the card's Undo shows it until the unit's last order changes. */
export interface UndoRefusal {
  readonly unitId: string
  readonly commandId: string
  readonly text: string
}

/** Who gave the unit's last order and where it sent the unit: the stops that actor gave, else the unit's status. */
const lastOrderText = (unit: SituationUnit): string | null => {
  const last = unit.lastOrder
  if (last === null) return null
  const stops = unit.plan.filter(stop => stop.by.isViewer === last.by.isViewer && stop.by.label === last.by.label).map(stop => stop.label)
  return `by ${last.by.label}: ${stops.length === 0 ? unit.status.word : stops.join(' → ')}`
}

const undoButton = (unit: SituationUnit, readOnly: string | null, refusal: UndoRefusal | null): UnitCardView['undo'] => {
  const commandId = unit.lastOrder?.commandId ?? null
  const lastOrder = lastOrderText(unit)
  const refused = refusal !== null && refusal.unitId === unit.id && refusal.commandId === commandId ? refusal.text : null
  return {
    ...button(lastOrder === null ? dispatchWords.undoLast : `${dispatchWords.undoLast} (${lastOrder})`, readOnly ?? (commandId === null ? dispatchWords.nothingToUndo : refused)),
    commandId,
  }
}

// Keep list ordering independent of live ETA changes so rows do not shift under a pointer.
const targetRows = (unit: SituationUnit, options: UnitOptions | null, words: Words): UnitCardView['targets'] => {
  const assigned = new Set(unit.plan.map(stop => stopKey(stop.target)))
  return (options?.targets ?? [])
    .filter(entry => !assigned.has(stopKey(entry.target)))
    .map(entry => ({
      key: stopKey(entry.target), target: entry.target,
      text: `${verbText(entry.verb, words)} ${entry.label}`,
      eta: entry.afterOnly ? 'After current stop' : minutesText(entry.etaS),
    }))
    .sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true }) || a.key.localeCompare(b.key))
}

/** The compact control card for the asset selected on the map or in the unit grid. */
export const unitCard = (situation: Situation, unit: SituationUnit, options: UnitOptions | null, elapsedS: number, undoRefusal: UndoRefusal | null = null): UnitCardView => {
  const { words } = situation
  const readOnly = unit.commandedBy === null ? null : `Commanded by ${unit.commandedBy}`
  const destroyed = unit.status.tone === 'out' ? unit.status.word : null
  const loaded = loadLabels(unit)
  const tasks = taskStopLabels(unit)
  const recallLabel = tasks.length === 0 ? words.return : `${words.return} (drops ${joined(tasks)})`
  const own = matchingOptions(unit, options)
  const commandable = canTarget(unit)
  const targets = commandable ? targetRows(unit, own, words) : []
  return {
    kind: 'unit',
    id: unit.id,
    icon: unit.icon,
    title: [unit.label, unit.typeLabel].join(' · '),
    status: { word: unit.status.word, tone: unit.status.tone, due: dueText(unit, elapsedS) },
    readOnly,
    recall: button(recallLabel, readOnly ?? destroyed ?? (loaded.length > 0 ? `Carrying ${joined(loaded)}: deliver first` : null)),
    undo: undoButton(unit, readOnly, undoRefusal),
    planHeading: words.plan,
    plan: unit.plan.map((stop, index) => ({
      id: stop.id,
      index: index + 1,
      text: `${verbText(stop.verb, words)} ${stop.label}`,
      removeLabel: `Remove ${words.stop.toLowerCase()} ${index + 1}: ${verbText(stop.verb, words)} ${stop.label}`,
      eta: stop.state === 'queued' && stop.eta?.kind === 'unavailable' ? null
        : stop.eta === null ? (index === 0 ? dueText(unit, elapsedS) : null) : etaText(stop.eta, elapsedS),
      active: stop.state === 'active',
      by: stop.by.isViewer ? null : `by ${stop.by.label}`,
      canMoveUp: commandable && stop.state === 'queued' && unit.plan[index - 1]?.state === 'queued',
      canMoveDown: commandable && stop.state === 'queued' && unit.plan[index + 1]?.state === 'queued',
    })),
    removable: commandable,
    predicted: unit.predictedDelivery === null ? null : [`then ${unit.predictedDelivery.label} (nearest accepting)`,
      ...(unit.predictedDelivery.eta.kind === 'unavailable' ? [] : [etaText(unit.predictedDelivery.eta, elapsedS)])].join(' · '),
    facts: [
      ...(unit.group === null ? [] : [unit.group.label]),
      ...(unit.carry === null ? [] : [`Capacity ${unit.carry.capacity}`]),
      ...loaded,
      ...unit.properties.map(property => `${property.label} ${property.value}`),
    ],
    states: unit.states.map(state => state.text),
    targets,
    targetsLoading: commandable && own === null,
    targetNotice: !commandable ? null : own === null ? dispatchWords.loadingTargets
      : targets.length > 0 ? 'Select a highlighted target.'
        : own.moveRefusal ?? 'No named targets available. You can select a point on the map.',
  }
}

const deliverySiteOf = (unit: SituationUnit): string | null => {
  const stop = unit.plan.find(entry => entry.verb === 'deliver')
  return stop !== undefined && 'siteId' in stop.target ? stop.target.siteId : unit.predictedDelivery?.siteId ?? null
}

// ——— Call card ———

/**
 * A call card's proposal, pinned when the card opened; the operator may drop
 * proposed units by their chips. `baseline` is each proposed unit's plan
 * (its stop ids) and status tone as the situation showed them at pinning:
 * the proposal stands until one of them changes in a way that matters.
 * `refreshing` holds the old answer, greyed, while Refresh asks again.
 */
export interface PinnedProposal {
  readonly callId: string
  readonly answer: RecommendAnswer
  readonly dropped: ReadonlySet<string>
  readonly baseline: ReadonlyMap<string, { readonly stopIds: ReadonlyArray<string>; readonly tone: UnitTone }>
  readonly refreshing: boolean
}

/** Pins a recommendation for a call against the situation the panel holds when it arrives (none yet: every proposed unit starts with no stops). */
export const pinProposal = (situation: Situation | null, callId: string, answer: RecommendAnswer): PinnedProposal => ({
  callId,
  answer,
  dropped: new Set(),
  baseline: new Map((answer.proposal?.units ?? []).flatMap(proposed => {
    const unit = situation?.units.find(entry => entry.id === proposed.unitId)
    return unit === undefined ? [] : [[unit.id, { stopIds: unit.plan.map(stop => stop.id), tone: unit.status.tone }] as const]
  })),
  refreshing: false,
})

/** The tones a proposed unit may not have turned to since pinning: it can no longer go. */
const unavailableTones: ReadonlySet<UnitTone> = new Set(['out', 'attention'])

/**
 * Why the pinned proposal no longer holds, in the situation's words; null
 * while it holds. Only a change since pinning counts: a proposed unit left
 * the situation, gained a stop, or turned out of action or needing
 * attention. A unit that was returning when the proposal was made (free, to
 * the engine) still holds.
 */
export const proposalInvalidation = (situation: Situation, pinned: PinnedProposal): string | null => {
  const proposal = pinned.answer.proposal
  if (proposal === null) return null
  for (const proposed of proposal.units) {
    const unit = situation.units.find(entry => entry.id === proposed.unitId)
    if (unit === undefined) return `${proposed.label}: ${dispatchWords.notListed.toLowerCase()}`
    const before = pinned.baseline.get(unit.id)
    const gained = unit.plan.find(stop => before === undefined || !before.stopIds.includes(stop.id))
    if (gained !== undefined) return `${unit.label} now on ${gained.label}`
    if (unavailableTones.has(unit.status.tone) && before?.tone !== unit.status.tone) return `${unit.label} now ${unit.status.word.toLowerCase()}`
  }
  return null
}

/**
 * The call card's command block, in fixed places from the moment the card
 * opens: the Dispatch button with Refresh beside it, the reason line under
 * them (why Dispatch is disabled, or that the suggestion is being read
 * again), then the unit chips and the coverage. While the answer is on its
 * way, and while Refresh reads it again, the block keeps its places, greyed.
 */
export interface ProposalView {
  readonly button: ButtonView
  readonly refresh: ButtonView
  readonly units: ReadonlyArray<{ readonly unitId: string; readonly label: string; readonly eta: string | null; readonly dropped: boolean }>
  readonly covers: string | null
  readonly remainder: string | null
  /** The order the button sends: the pinned one, less the dropped units; null when it may not be sent. */
  readonly order: UnitOrderInput | null
  /** True once the Run has invalidated the pinned proposal. */
  readonly stale: boolean
  /** True while the chips and alternatives take no tap: the answer is on its way or being read again. */
  readonly waiting: boolean
}

export interface DeliverToView {
  readonly unitLabel: string
  /** "Deliver to (R1)", or "Deliver to (R1, after Dispatch)" until the carrier is on the call. */
  readonly heading: string
  /** False until the carrier is on the call: the sites are named, not offered. */
  readonly enabled: boolean
  /** Each site's chip; `selected` is where the carrier's load goes now. */
  readonly sites: ReadonlyArray<{ readonly siteId: string; readonly text: string; readonly selected: boolean; readonly order: UnitOrderInput }>
}

export interface CallCardView {
  readonly kind: 'call'
  readonly id: string
  readonly icon: string
  readonly label: string
  readonly code: string
  readonly priority: string
  readonly isNew: boolean
  readonly waiting: string
  readonly overdue: string | null
  /** "Observed by D-1 at 14:02 UTC": the latest observation by another Pack's sensor; null before one. */
  readonly observed: string | null
  readonly needs: ReadonlyArray<{ readonly text: string; readonly met: boolean }>
  readonly proposal: ProposalView
  /** The proposed carriers' Deliver-to chips, directly under the command block: shown from pinning, live once the carrier is on the call. */
  readonly deliverTo: ReadonlyArray<DeliverToView>
  /** Per need: other free units, each a labelled order ("Dispatch E3 · 9 min"). */
  readonly alternatives: ReadonlyArray<{ readonly heading: string; readonly units: ReadonlyArray<{ readonly unitId: string; readonly text: string; readonly order: UnitOrderInput }> }>
  readonly whyNot: ReadonlyArray<{ readonly label: string; readonly reasons: string }>
  /** Below the commands, so an order landing never moves a command. */
  readonly assigned: ReadonlyArray<{ readonly unitId: string; readonly text: string }>
  readonly close: { readonly label: string; readonly confirm: string }
  readonly states: ReadonlyArray<string>
}

/** A call that left the situation: closed, served by the units last seen on it. */
export interface ClosedCallView {
  readonly kind: 'closed-call'
  readonly id: string
  readonly label: string
  readonly text: string
}

const needText = (need: SituationCall['needs'][number]): { readonly text: string; readonly met: boolean } => {
  if (need.kind === 'load') return { text: `${need.label} ${need.covered}/${need.waiting}`, met: need.covered >= need.waiting }
  const have = need.enRoute + need.onTask + need.completed
  const where = need.where.length === 0 ? '' : ` (${need.where.join(', ')})`
  return { text: `${need.label}${where} ${have}/${need.count}`, met: have >= need.count }
}

/** No proposal: every need is covered, else no free unit can help. */
const proposalView = (situation: Situation, pinned: PinnedProposal | null, covered: boolean): ProposalView => {
  const { words } = situation
  const proposal = pinned?.answer.proposal ?? null
  const kept = proposal === null || pinned === null ? [] : proposal.units.filter(unit => !pinned.dropped.has(unit.unitId))
  const stale = pinned === null ? null : proposalInvalidation(situation, pinned)
  const slowest = Math.max(0, ...kept.map(unit => etaSeconds(unit.eta) ?? 0))
  const label = kept.length === 0 ? words.send : `${words.send} ${joined(kept.map(unit => unit.label))}${slowest > 0 ? ` · ${minutesText(slowest)}` : ''}`
  const waiting = pinned === null || pinned.refreshing
  const reason = pinned === null
    ? dispatchWords.loading
    : pinned.refreshing
      ? dispatchWords.refreshing
      : proposal === null ? (covered ? dispatchWords.covered : dispatchWords.noFreeUnit) : stale ?? (kept.length === 0 ? dispatchWords.noUnitChosen : null)
  const refreshable = pinned !== null && !pinned.refreshing && (proposal === null || stale !== null)
  return {
    button: button(label, reason),
    refresh: button(dispatchWords.refresh, refreshable ? null : dispatchWords.suggestionHolds),
    units: proposal === null || pinned === null ? [] : proposal.units.map(unit => ({ unitId: unit.unitId, label: unit.label, eta: etaText(unit.eta), dropped: pinned.dropped.has(unit.unitId) })),
    covers: proposal === null ? null : `covers ${proposal.covers.covered} of ${proposal.covers.needed}`,
    remainder: proposal === null || proposal.remainder.length === 0 ? null : `still needs ${joined(proposal.remainder)}`,
    order: reason === null && proposal !== null && pinned !== null ? { ...proposal.order, units: proposal.order.units.filter(id => !pinned.dropped.has(id)) } : null,
    stale: stale !== null,
    waiting,
  }
}

/** A call's card, with its pinned proposal once it arrived. */
export const callCard = (situation: Situation, call: SituationCall, pinned: PinnedProposal | null, opened: ReadonlySet<string>, elapsedS: number): CallCardView => {
  const { words } = situation
  const waitedS = call.waitingS + elapsedS
  const target = call.priority.responseTargetS
  const answer = pinned !== null && pinned.callId === call.id ? pinned : null
  const assignedIds = new Set(call.assigned.map(unit => unit.unitId))
  const frees = call.assigned.map(unit => unit.label)
  const live = answer !== null && !answer.refreshing
  const needs = call.needs.map(needText)
  return {
    kind: 'call',
    id: call.id,
    icon: call.icon,
    label: call.label,
    code: call.priority.code,
    priority: call.priority.label,
    isNew: isNewCall(call, opened),
    waiting: `${dispatchWords.waiting} ${clockText(waitedS)}`,
    overdue: target === undefined ? null : waitedS < target ? `overdue in ${clockText(target - waitedS)}` : `${dispatchWords.overdue} by ${clockText(waitedS - target)}`,
    observed: call.observed === undefined ? null : `${dispatchWords.observedBy} ${call.observed.by} at ${call.observed.at.slice(11, 16)} UTC`,
    needs,
    proposal: proposalView(situation, answer, needs.every(need => need.met)),
    deliverTo: answer === null ? [] : answer.answer.deliverTo.map(entry => {
      const enabled = live && assignedIds.has(entry.unitId)
      const carrier = situation.units.find(unit => unit.id === entry.unitId)
      const delivery = enabled && carrier !== undefined ? deliverySiteOf(carrier) : null
      return {
        unitLabel: entry.label,
        heading: enabled ? `${dispatchWords.deliverTo} (${entry.label})` : `${dispatchWords.deliverTo} (${entry.label}, after ${words.send})`,
        enabled,
        sites: entry.sites.map(site => ({
          siteId: site.siteId,
          text: `${site.label} · ${etaText(site.eta)}`,
          selected: site.siteId === delivery,
          order: { units: [entry.unitId], stops: [{ siteId: site.siteId }], when: 'after' as const },
        })),
      }
    }),
    alternatives: answer === null ? [] : answer.answer.alternatives.filter(entry => entry.units.length > 0).map(entry => ({
      heading: `Other: ${entry.need.label}`,
      units: entry.units.map(unit => ({ unitId: unit.unitId, text: `${words.send} ${unit.label} · ${etaText(unit.eta)}`, order: unit.order })),
    })),
    whyNot: answer === null ? [] : answer.answer.whyNot.map(entry => ({ label: entry.label, reasons: entry.reasons.join('; ') })),
    assigned: call.assigned.map(unit => ({
      unitId: unit.unitId,
      text: [unit.label, unit.status.word, ...(unit.eta === null ? [] : [etaText(unit.eta, elapsedS)!]), `by ${unit.by.label}`].join(' · '),
    })),
    close: {
      label: frees.length === 0 ? words.close : `${words.close} (frees ${joined(frees)})`,
      confirm: frees.length === 0 ? dispatchWords.confirm : `${dispatchWords.confirm}: frees ${joined(frees)}`,
    },
    states: call.states.map(state => state.text),
  }
}

/** The card of a call the situation no longer lists. */
export const closedCallCard = (lastSeen: SituationCall): ClosedCallView => ({
  kind: 'closed-call',
  id: lastSeen.id,
  label: lastSeen.label,
  text: lastSeen.assigned.length === 0 ? dispatchWords.closed : `${dispatchWords.closed} · served by ${joined(lastSeen.assigned.map(unit => unit.label))}`,
})

/** Unassigned and not yet opened by this viewer: the call carries the New badge. */
export const isNewCall = (call: SituationCall, opened: ReadonlySet<string>): boolean => call.assigned.length === 0 && !opened.has(call.id)

// ——— Site card ———

export interface SiteCardView {
  readonly kind: 'site'
  readonly id: string
  readonly icon: string
  readonly title: string
  /** What a site that receives load shows: its accepting state, the toggle naming its effect, its slots; null for a place that receives none (a depot, an objective). */
  readonly receiving: {
    readonly accepting: string
    readonly toggle: { readonly label: string; readonly accepting: boolean }
    readonly slots: string
  } | null
  readonly inbound: ReadonlyArray<string>
  readonly states: ReadonlyArray<string>
}

export const siteCard = (site: SituationSite, elapsedS: number): SiteCardView => {
  const inbound = site.inbound.map(unit => unit.label)
  const { accepting, slots } = site
  return {
    kind: 'site',
    id: site.id,
    icon: site.icon,
    title: `${site.label} · ${site.typeLabel}`,
    receiving: accepting === null || slots === null ? null : {
      accepting: accepting ? dispatchWords.accepting : dispatchWords.notAccepting,
      toggle: accepting
        ? { label: inbound.length === 0 ? dispatchWords.closeArrivals : `${dispatchWords.closeArrivals} (${joined(inbound)} will go elsewhere)`, accepting: false }
        : { label: dispatchWords.openArrivals, accepting: true },
      slots: `${slots.used} of ${slots.total} ${dispatchWords.slots}`,
    },
    inbound: site.inbound.map(unit => [unit.label, ...(unit.eta === null ? [] : [etaText(unit.eta, elapsedS)!])].join(' · ')),
    states: site.states.map(state => state.text),
  }
}

export type CardView = UnitCardView | CallCardView | ClosedCallView | SiteCardView

/** What the panel holds besides the situation for its selection block. */
export interface CardInputs {
  readonly options: UnitOptions | null
  readonly pinned: PinnedProposal | null
  readonly opened: ReadonlySet<string>
  /** The selected call's row as last seen, for its card once it closed. */
  readonly lastSeenCall: SituationCall | null
  readonly elapsedS: number
  /** The engine's last refusal of an Undo, for the unit card's Undo. */
  readonly undoRefusal: UndoRefusal | null
}

/** The selection block's card; null for S0 (and a marked track). A unit or site the situation no longer lists has no card. */
export const cardFor = (situation: Situation, selection: Selection, inputs: CardInputs): CardView | null => {
  switch (selection.kind) {
    case 'none': return null
    case 'unit': {
      const unit = situation.units.find(entry => entry.id === selection.unitId)
      return unit === undefined ? null : unitCard(situation, unit, inputs.options, inputs.elapsedS, inputs.undoRefusal)
    }
    case 'call': {
      const call = situation.calls.find(entry => entry.id === selection.callId)
      if (call !== undefined) return callCard(situation, call, inputs.pinned, inputs.opened, inputs.elapsedS)
      const seen = inputs.lastSeenCall
      return seen === null || seen.id !== selection.callId ? null : closedCallCard(seen)
    }
    case 'site': {
      const site = situation.sites.find(entry => entry.id === selection.siteId)
      return site === undefined ? null : siteCard(site, inputs.elapsedS)
    }
  }
}

/** What the empty selection block says: the one instruction. */
export const emptySelectionText = (words: Words): string => `Click one of the ${words.calls.toLowerCase()} or ${words.units.toLowerCase()}`

// ——— Overview ———

type RowProgress = 'active' | 'covered' | null

export interface CallRowView {
  readonly id: string
  readonly icon: string
  readonly code: string
  readonly label: string
  readonly waiting: string
  readonly needs: string
  readonly assigned: string | null
  readonly isNew: boolean
  readonly overdue: boolean
  readonly states: ReadonlyArray<string>
  readonly progress: RowProgress
  readonly selected: boolean
}

export interface UnitRowView {
  readonly id: string
  readonly icon: string
  readonly label: string
  readonly status: { readonly word: string; readonly tone: UnitTone }
  readonly current: string | null
  readonly actor: string | null
  /** Load on board, only when some type carries. */
  readonly carry: string | null
  /** "Water 3,000 l" per property column, in column order, label and value as the card shows them; none where the type has none. */
  readonly properties: ReadonlyArray<string>
  readonly states: ReadonlyArray<string>
  readonly progress: RowProgress
  readonly selected: boolean
}

export interface SiteRowView {
  readonly id: string
  readonly icon: string
  readonly label: string
  /** A site that receives load: its accepting state and slots; null for a place that receives none. */
  readonly receiving: { readonly accepting: string; readonly slots: string } | null
  readonly inbound: string | null
  readonly states: ReadonlyArray<string>
  readonly progress: RowProgress
  readonly selected: boolean
}

export interface OverviewView {
  readonly counts: string
  readonly calls: { readonly heading: string; readonly empty: string | null; readonly rows: ReadonlyArray<CallRowView> }
  readonly units: { readonly heading: string; readonly empty: string | null; readonly groups: ReadonlyArray<{ readonly heading: string; readonly rows: ReadonlyArray<UnitRowView> }> }
  /** Only when some type receives load. */
  readonly sites: { readonly heading: string; readonly rows: ReadonlyArray<SiteRowView> } | null
  readonly columns: { readonly carry: boolean }
  /** Only when some type declares a sensor or an effector. */
  readonly contacts: boolean
  /** While a unit is selected the lists fold to the counts line. */
  readonly folded: boolean
}

/** The counts line: open calls per priority code, the oldest wait, free units of all, accepting sites of all. */
export const countsLine = (situation: Situation, elapsedS: number): string => {
  const { counts, words } = situation
  const calls = counts.calls.filter(entry => entry.count > 0)
  return [
    calls.length === 0 ? words.noCalls : calls.map(entry => `${entry.code} ${entry.count}`).join(' '),
    ...(counts.oldestWaitingS === null ? [] : [`${dispatchWords.oldest} ${clockText(counts.oldestWaitingS + elapsedS)}`]),
    `${counts.freeUnits}/${counts.units} ${dispatchWords.free}`,
    ...(situation.features.hasSites ? [`${counts.acceptingSites}/${counts.sites} ${words.sites.toLowerCase()} ${dispatchWords.open}`] : []),
  ].join(' · ')
}

/** The folded edge tab below 1024 px: "Calls 3 · 7 free". */
export const edgeTabText = (situation: Situation): string =>
  `${situation.words.calls} ${situation.calls.length} · ${situation.counts.freeUnits} ${dispatchWords.free}`

const callRow = (call: SituationCall, opened: ReadonlySet<string>, selectedId: string | null, elapsedS: number): CallRowView => {
  const needs = call.needs.map(needText)
  const covered = call.states.length === 0 && needs.every(need => need.met)
  const completedWork = call.needs.some(need => need.kind === 'requirement' && need.completed > 0)
  return {
    id: call.id,
    icon: call.icon,
    code: call.priority.code,
    label: call.label,
    waiting: clockText(call.waitingS + elapsedS),
    needs: needs.map(need => need.text).join(' · '),
    assigned: call.assigned.length === 0 ? null : joined(call.assigned.map(unit => unit.label)),
    isNew: isNewCall(call, opened) && !(covered && completedWork),
    overdue: call.overdue === true,
    states: call.states.map(state => state.text),
    progress: covered ? call.assigned.length > 0 ? 'active' : completedWork ? 'covered' : null : null,
    selected: call.id === selectedId,
  }
}

const unitRow = (situation: Situation, unit: SituationUnit, selectedId: string | null, elapsedS: number): UnitRowView => {
  const current = unit.plan[0]
  const active = current?.state === 'active' || unit.status.tone === 'busy' || unit.status.tone === 'returning'
  return {
    id: unit.id,
    icon: unit.icon,
    label: unit.label,
    status: unit.status,
    current: current === undefined ? null : [current.label, ...(current.eta === null ? [] : [etaText(current.eta, elapsedS)!])].join(' · '),
    actor: unit.lastOrder === null || unit.lastOrder.by.isViewer ? null : `by ${unit.lastOrder.by.label}`,
    carry: !situation.features.hasCarry || unit.carry === null ? null : `${unit.carry.load.reduce((sum, entry) => sum + entry.count, 0)}/${unit.carry.capacity}`,
    properties: situation.features.propertyColumns.flatMap(column => unit.properties.filter(property => property.id === column.id).map(property => `${property.label} ${property.value}`)),
    states: unit.states.map(state => state.text),
    progress: unit.states.length === 0 && !unavailableTones.has(unit.status.tone) && active ? 'active' : null,
    selected: unit.id === selectedId,
  }
}

/** Units grouped under their group's label, else their type's; in each group the free ones first, so they are named at a glance, then the rest, each in the situation's order. */
const unitGroups = (situation: Situation, selectedId: string | null, elapsedS: number): OverviewView['units']['groups'] => {
  const groups = new Map<string, UnitRowView[]>()
  const freeFirst = [...situation.units.filter(unit => unit.status.tone === 'free'), ...situation.units.filter(unit => unit.status.tone !== 'free')]
  for (const unit of situation.units) groups.set(unit.group?.label ?? unit.typeLabel, [])
  for (const unit of freeFirst) groups.get(unit.group?.label ?? unit.typeLabel)!.push(unitRow(situation, unit, selectedId, elapsedS))
  return [...groups].map(([heading, rows]) => ({ heading, rows }))
}

const siteRow = (site: SituationSite, selectedId: string | null): SiteRowView => ({
  id: site.id,
  icon: site.icon,
  label: site.label,
  receiving: site.accepting === null || site.slots === null ? null : { accepting: site.accepting ? dispatchWords.accepting : dispatchWords.notAccepting, slots: `${site.slots.used}/${site.slots.total}` },
  inbound: site.inbound.length === 0 ? null : `${dispatchWords.inbound} ${joined(site.inbound.map(unit => unit.label))}`,
  states: site.states.map(state => state.text),
  progress: site.states.length === 0 && site.inbound.length > 0 ? 'active' : null,
  selected: site.id === selectedId,
})

/** The panel's lists under the selection block. */
export const overview = (situation: Situation, selection: Selection, opened: ReadonlySet<string>, elapsedS: number): OverviewView => {
  const { words, features } = situation
  const selectedId = selectedObjectOf(selection)
  return {
    counts: countsLine(situation, elapsedS),
    calls: { heading: words.calls, empty: situation.calls.length === 0 ? words.noCalls : null, rows: situation.calls.map(call => callRow(call, opened, selectedId, elapsedS)) },
    units: { heading: words.units, empty: situation.units.length === 0 ? words.noUnits : null, groups: unitGroups(situation, selectedId, elapsedS) },
    sites: features.hasSites ? { heading: words.sites, rows: situation.sites.map(site => siteRow(site, selectedId)) } : null,
    columns: { carry: features.hasCarry },
    contacts: features.hasContacts,
    folded: selection.kind === 'unit',
  }
}

// ——— Selected unit's targets on the map ———

export const targetingFor = (unit: SituationUnit | undefined, options: UnitOptions | null): MapTargeting | null => {
  if (!unit || !canTarget(unit)) return null
  const own = matchingOptions(unit, options)
  const numbers = new Map<string, number[]>()
  unit.plan.forEach((stop, index) => {
    const id = stopObjectId(stop.target)
    if (id !== null) numbers.set(id, [...(numbers.get(id) ?? []), index + 1])
  })
  const assigned = [...numbers].map(([id, indices], index) => ({
    id: objectIdSchema.parse(id), tone: 'assigned' as const,
    ...(index < mapTargetingMaxTags ? { tag: `Plan ${indices.join(', ')}` } : {}),
  }))
  const available = (own?.targets ?? []).flatMap(entry => {
    const id = stopObjectId(entry.target)
    return id === null || numbers.has(id) ? [] : [{
      id: objectIdSchema.parse(id), tag: entry.afterOnly ? 'After current stop' : minutesText(entry.etaS),
    }]
  })
  return {
    from: objectIdSchema.parse(unit.id),
    complete: own !== null,
    targets: [...assigned, ...available.map((entry, index) =>
      index + assigned.length < mapTargetingMaxTags ? { ...entry, tone: 'valid' as const } : { id: entry.id, tone: 'valid' as const })],
  }
}

/** A stop in words, for a receipt or a decision: as the unit's options list it, else its call's, site's or object's label; a point is the map point. */
export const stopLabelOf = (stop: Stop, situation: Situation | null, options: UnitOptions | null, objects: ReadonlyArray<Pick<OperationalObject, 'id' | 'label'>>): string => {
  const listed = options?.targets.find(target => stopKey(target.target) === stopKey(stop))?.label
  if (listed !== undefined) return listed
  const id = stopObjectId(stop)
  if (id === null) return dispatchWords.mapPoint
  return situation?.calls.find(call => call.id === id)?.label ?? situation?.sites.find(site => site.id === id)?.label ?? objects.find(object => object.id === id)?.label ?? id
}

/** The pinned proposal with one unit's chip toggled: dropped from the order, or restored to it. */
export const toggledChip = (pinned: PinnedProposal, unitId: string): PinnedProposal => {
  const dropped = new Set(pinned.dropped)
  if (dropped.has(unitId)) dropped.delete(unitId)
  else dropped.add(unitId)
  return { ...pinned, dropped }
}

// ——— Receipts ———

export interface Receipt {
  readonly commandId: string
  /** The units the order named. */
  readonly unitIds: ReadonlyArray<string>
  /**
   * Who gave the order, in the situation's words for its actor, the one word
   * every surface uses; null on this viewer's own receipt until a situation
   * read names its command.
   */
  readonly actor: string | null
  /** The unit, the target and what was dropped: "A2 → C-1 (drops C-3 · P3)". */
  readonly text: string
  /**
   * Its Undo, "Undo (A2 returns to C-3 · P3)" when the order dropped a task,
   * else "Undo": only on this screen's own orders; null on another actor's
   * and on a return, which the engine never takes back.
   */
  readonly undo: string | null
  readonly atMs: number
  /** This viewer's own order, from its own result: it names what the order dropped, which the situation cannot. */
  readonly own: boolean
}

/** A receipt's line: "Operator: A2 → C-1 (drops C-3 · P3)". */
export const receiptText = (receipt: Receipt): string => receipt.actor === null ? receipt.text : `${receipt.actor}: ${receipt.text}`

/** A receipt of this viewer's own accepted order, naming what it dropped; its actor comes from the situation. */
export const ownReceipt = (options: { readonly commandId: string; readonly unitIds: ReadonlyArray<string>; readonly unitLabel: string; readonly targetLabel: string; readonly dropped: string | null; readonly undoable: boolean; readonly atMs: number }): Receipt => ({
  commandId: options.commandId,
  unitIds: options.unitIds,
  actor: null,
  text: `${options.unitLabel} → ${options.targetLabel}${options.dropped === null ? '' : ` (drops ${options.dropped})`}`,
  undo: !options.undoable ? null : options.dropped === null ? dispatchWords.undo : `${dispatchWords.undo} (${options.unitLabel} returns to ${options.dropped})`,
  atMs: options.atMs,
  own: true,
})

/** Whether a receipt still offers its Undo: this screen's own order, for `receiptUndoMs` after it was accepted. */
export const receiptUndoable = (receipt: Receipt, nowMs: number): boolean => receipt.undo !== null && nowMs - receipt.atMs < receiptUndoMs

/** Receipts of orders the situation shows as new since the previous read: another actor's, or this viewer's, whose own receipt then takes its actor. */
export const receiptsFromSituation = (previous: Situation | null, next: Situation, atMs: number): ReadonlyArray<Receipt> => {
  if (previous === null) return []
  const before = new Map(previous.units.map(unit => [unit.id, unit.lastOrder?.commandId ?? null]))
  return next.units.flatMap(unit => {
    const commandId = unit.lastOrder?.commandId ?? null
    if (commandId === null || unit.lastOrder === null || before.get(unit.id) === commandId) return []
    const target = unit.plan[0]?.label ?? unit.status.word
    return [{ commandId, unitIds: [unit.id], actor: unit.lastOrder.by.label, text: `${unit.label} → ${target}`, undo: null, atMs, own: false }]
  })
}

/**
 * Adds receipts, newest on top; one per command, at most `maxReceipts`. A
 * viewer's own receipt takes the place of the situation's for the same
 * command, whichever arrived first, so what it names is never lost; it
 * keeps that place, its Undo window and the actor the situation names.
 */
export const withReceipts = (list: ReadonlyArray<Receipt>, added: ReadonlyArray<Receipt>): ReadonlyArray<Receipt> => {
  const ownOf = new Map(added.filter(receipt => receipt.own).map(receipt => [receipt.commandId, receipt]))
  const actorOf = new Map(added.filter(receipt => !receipt.own).map(receipt => [receipt.commandId, receipt.actor]))
  const kept = list.map(receipt => {
    if (receipt.own) return receipt.actor === null && actorOf.has(receipt.commandId) ? { ...receipt, actor: actorOf.get(receipt.commandId)! } : receipt
    const own = ownOf.get(receipt.commandId)
    return own === undefined ? receipt : { ...own, actor: receipt.actor, atMs: receipt.atMs }
  })
  const known = new Set(list.map(receipt => receipt.commandId))
  const fresh = added.filter((receipt, index) => !known.has(receipt.commandId) && added.findIndex(entry => entry.commandId === receipt.commandId) === index)
  return [...fresh.reverse(), ...kept].slice(0, maxReceipts)
}


// ——— Contacts ———

export interface ContactRowView {
  readonly id: string
  readonly icon: string
  readonly label: string
  readonly text: string
  readonly age: string | null
  readonly destroyed: boolean
  readonly selected: boolean
}

const tierOrder: Readonly<Record<TrackTier, number>> = { identified: 0, contact: 1, destroyed: 2 }

/** The tracks this screen sees, identified first, then contacts, then destroyed, with the age of the last detection. */
export const contactRows = (objects: ReadonlyArray<OperationalObject>, nowMs: number | null, selectedId: string | null): ReadonlyArray<ContactRowView> =>
  objects.flatMap(object => {
    if (object.packId !== einsatzPackId) return []
    const track = einsatzRecordOf(object)
    if (track.type !== 'track') return []
    return [{
      tier: track.tier,
      row: {
        id: object.id as string,
        icon: track.identity?.icon ?? contactIcon,
        label: object.label,
        text: track.identity === undefined ? tierWord(track.tier) : `${tierWord(track.tier)} · ${track.identity.typeLabel}`,
        age: trackAgeText(object, nowMs),
        destroyed: track.tier === 'destroyed',
        selected: object.id === selectedId,
      },
    }]
  }).sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.row.label.localeCompare(b.row.label)).map(entry => entry.row)
