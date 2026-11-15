import { z } from 'zod'
import { objectIdSchema, type OperationalObject } from '../../../core/model/index.ts'
import { einsatzPackId } from '../ids.ts'
import { neutralLexicon, unitPhases } from '../lexicon.ts'
import type { Stop, UnitOrderInput } from '../order-schema.ts'
import type { Eta, RecommendAnswer } from '../recommendation-schema.ts'
import type { Situation, SituationCall, SituationSite, SituationUnit, StopVerb, UnitOptions, UnitTone } from '../situation/schema.ts'
import { mapTargetingMaxTargets, type MapTargeting } from '../../../ui/surface-panel-interaction.ts'
import { selectedObjectOf, stopObjectId, type DispatchObjectKind, type Selection } from './selection.ts'

/**
 * What the Dispatch panel shows, as plain view models over the Run's own
 * read models: `world.einsatz.situation` for the lists and cards,
 * `world.einsatz.unit.options` for an armed unit and the call card's pinned
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

/** How long a receipt offers Undo. The card's "Undo last order" stays until the engine refuses it. */
export const receiptUndoMs = 8_000
/** The most receipts the footer keeps, newest on top. */
export const maxReceipts = 3
/** The icon a contact shows: it has no identified type. */
export const contactIcon = 'circle-question-mark'

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
  after: 'After current job',
  now: 'Now',
  free: 'free',
  oldest: 'oldest',
  open: 'open',
  confirm: 'Confirm',
  cancel: 'Cancel',
  noFreeUnit: 'No free unit can help',
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
  refusedTargets: 'Refused',
  loadingTargets: 'Reading targets… a click on the map still sends',
  you: 'You',
  mapPoint: 'the map point',
} as const

const clockPad = (value: number): string => value.toString().padStart(2, '0')

/** Seconds as m:ss, or h:mm:ss from an hour. */
export const clockText = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds))
  const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
  return hours > 0 ? `${hours}:${clockPad(minutes)}:${clockPad(rest)}` : `${minutes}:${clockPad(rest)}`
}

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

const actorText = (by: { readonly label: string; readonly isViewer: boolean }): string => by.isViewer ? dispatchWords.you : by.label
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

/** What a record is to the panel: a unit that receives load is a site, any other unit a unit, a task a call, a track a track; a track index none of them. */
export const kindOfRecord = (record: EinsatzRecord): DispatchObjectKind | null => {
  switch (record.type) {
    case 'unit': return record.accepting === undefined ? 'unit' : 'site'
    case 'task': return 'call'
    case 'track': return 'track'
    case 'track-index': return null
  }
}

/** What an object is to the panel; another Pack's object is none of them. */
export const dispatchKindOf = (object: Pick<OperationalObject, 'packId' | 'packData'>): DispatchObjectKind | null =>
  object.packId === einsatzPackId ? kindOfRecord(einsatzRecordOf(object)) : null

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

// ——— Unit card ———

export interface PlanStopView {
  readonly id: string
  readonly index: number
  readonly text: string
  readonly eta: string | null
  readonly active: boolean
  /** Who gave it, when not this viewer. */
  readonly by: string | null
  /** The × that removes it, named in the situation's stop word. */
  readonly removeLabel: string
}

export interface ArmedTargetView {
  readonly key: string
  readonly target: Stop
  readonly text: string
  readonly eta: string
  /** "drops C-3 · P3" for a busy unit's current task. */
  readonly drops: string | null
}

export interface RefusedTargetView {
  readonly key: string
  readonly target: Stop
  readonly label: string
  readonly text: string
}

export interface ArmedView {
  readonly banner: string
  readonly targets: ReadonlyArray<ArmedTargetView>
  readonly refused: ReadonlyArray<RefusedTargetView>
  /** True while the unit's options are on their way; a target click still submits. */
  readonly loading: boolean
  /** The last refusal, also shown at its target. */
  readonly refusal: string | null
  /** The busy prompt's choices, also offered here off the map; null while none is asked. */
  readonly busy: { readonly after: string; readonly now: string } | null
}

export interface UnitCardView {
  readonly kind: 'unit'
  readonly id: string
  readonly icon: string
  readonly title: string
  readonly status: { readonly word: string; readonly tone: UnitTone; readonly due: string | null }
  /** "Commanded by …" for a unit the viewer cannot command: the card is read-only. */
  readonly readOnly: string | null
  readonly dispatch: ButtonView
  readonly recall: ButtonView
  readonly undo: ButtonView & { readonly commandId: string | null }
  /** The situation's word for the unit's stops. */
  readonly planHeading: string
  readonly plan: ReadonlyArray<PlanStopView>
  readonly removable: boolean
  readonly predicted: string | null
  readonly deliverTo: ReadonlyArray<{ readonly siteId: string; readonly label: string }>
  /** "+ Add stop" in the situation's stop word, only while the unit has a plan. */
  readonly addStop: ButtonView | null
  readonly facts: ReadonlyArray<string>
  readonly states: ReadonlyArray<string>
  readonly armed: ArmedView | null
}

const taskStopLabels = (unit: SituationUnit): ReadonlyArray<string> => unit.plan.filter(stop => 'taskId' in stop.target).map(stop => stop.label)
const loadLabels = (unit: SituationUnit): ReadonlyArray<string> => unit.carry?.load.filter(entry => entry.count > 0).map(entry => entry.label) ?? []

const dueText = (unit: SituationUnit, elapsedS: number): string | null => unit.phaseDueInS === null ? null : clockText(unit.phaseDueInS - elapsedS)

const stopKey = (target: Stop): string => JSON.stringify(target)

const busyChoices = (selection: Extract<Selection, { kind: 'armed' }>, options: UnitOptions | null, unitId: string): ArmedView['busy'] => {
  const prompt = selection.prompt?.kind === 'busy' ? busyPrompt(options, unitId) : null
  return prompt === null ? null : { after: prompt.after, now: prompt.now }
}

const armedView = (unit: SituationUnit, words: Words, options: UnitOptions | null, selection: Extract<Selection, { kind: 'armed' }>): ArmedView => {
  const own = options !== null && options.unitId === unit.id ? options : null
  return {
    banner: `${words.send} ${unit.label}…${selection.when === 'after' ? ` (${dispatchWords.after.toLowerCase()})` : ''}`,
    targets: own === null ? [] : own.targets.map(target => ({
      key: stopKey(target.target),
      target: target.target,
      text: `${verbText(target.verb, words)} ${target.label}`,
      eta: minutesText(target.etaS),
      drops: target.drops === undefined ? null : `drops ${target.drops.label} · ${target.drops.code}`,
    })),
    refused: own === null ? [] : own.refused.map(entry => ({ key: stopKey(entry.target), target: entry.target, label: entry.label, text: entry.text })),
    loading: own === null,
    refusal: selection.refusal?.text ?? null,
    busy: busyChoices(selection, own, unit.id),
  }
}

/** A unit's card, armed or not. */
export const unitCard = (situation: Situation, unit: SituationUnit, selection: Selection, options: UnitOptions | null, elapsedS: number): UnitCardView => {
  const { words } = situation
  const readOnly = unit.commandedBy === null ? null : `Commanded by ${unit.commandedBy}`
  const destroyed = unit.status.tone === 'out' ? unit.status.word : null
  const loaded = loadLabels(unit)
  const tasks = taskStopLabels(unit)
  const recallLabel = tasks.length === 0 ? words.return : `${words.return} (drops ${joined(tasks)})`
  const lastCommand = unit.lastOrder?.commandId ?? null
  const bound = loaded.length > 0 || unit.plan.some(stop => stop.verb === 'pick-up')
  const facts = [
    ...(unit.carry === null ? [] : [`carries ${unit.carry.capacity}`]),
    ...unit.properties.map(property => `${property.label} ${property.value}`),
  ]
  return {
    kind: 'unit',
    id: unit.id,
    icon: unit.icon,
    title: [unit.label, unit.typeLabel, ...(unit.group === null ? [] : [unit.group.label])].join(' · '),
    status: { word: unit.status.word, tone: unit.status.tone, due: dueText(unit, elapsedS) },
    readOnly,
    dispatch: button(`${words.send} ${unit.label}…`, readOnly ?? destroyed),
    recall: button(recallLabel, readOnly ?? destroyed ?? (loaded.length > 0 ? `Carrying ${joined(loaded)}: deliver first` : null)),
    undo: { ...button(dispatchWords.undoLast, readOnly ?? (lastCommand === null ? dispatchWords.nothingToUndo : null)), commandId: lastCommand },
    planHeading: words.plan,
    plan: unit.plan.map((stop, index) => ({
      id: stop.id,
      index: index + 1,
      text: `${verbText(stop.verb, words)} ${stop.label}`,
      removeLabel: `Remove ${words.stop.toLowerCase()} ${index + 1}: ${verbText(stop.verb, words)} ${stop.label}`,
      eta: stop.eta === null ? (index === 0 ? dueText(unit, elapsedS) : null) : etaText(stop.eta, elapsedS),
      active: stop.state === 'active',
      by: stop.by.isViewer ? null : `by ${stop.by.label}`,
    })),
    removable: readOnly === null,
    predicted: unit.predictedDelivery === null ? null : `then ${unit.predictedDelivery.label} (nearest accepting) · ${etaText(unit.predictedDelivery.eta, elapsedS)}`,
    deliverTo: readOnly !== null || !bound ? [] : situation.sites.filter(site => site.accepting).map(site => ({ siteId: site.id, label: site.label })),
    addStop: unit.plan.length === 0 ? null : button(`+ Add ${words.stop.toLowerCase()}`, readOnly ?? destroyed),
    facts,
    states: unit.states.map(state => state.text),
    armed: selection.kind === 'armed' && selection.unitId === unit.id ? armedView(unit, words, options, selection) : null,
  }
}

/** The order a Deliver-to chip of the unit card sends: a site stop after the unit's plan. */
export const deliverToOrder = (unit: SituationUnit, siteId: string): UnitOrderInput => ({
  units: [unit.id],
  stops: [{ siteId }],
  ...(unit.plan.length > 0 ? { when: 'after' as const } : {}),
})

// ——— Call card ———

/** A call card's proposal, pinned when the card opened; the operator may drop proposed units by their chips. */
export interface PinnedProposal {
  readonly callId: string
  readonly answer: RecommendAnswer
  readonly dropped: ReadonlySet<string>
}

export interface ProposalView {
  readonly button: ButtonView
  readonly units: ReadonlyArray<{ readonly unitId: string; readonly label: string; readonly eta: string | null; readonly dropped: boolean }>
  readonly covers: string
  readonly remainder: string | null
  /** The order the button sends: the pinned one, less the dropped units; null when it may not be sent. */
  readonly order: UnitOrderInput | null
  /** True once the Run has invalidated the pinned proposal. */
  readonly stale: boolean
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
  readonly needs: ReadonlyArray<{ readonly text: string; readonly met: boolean }>
  readonly assigned: ReadonlyArray<{ readonly unitId: string; readonly text: string }>
  /** Null while the recommendation is on its way. */
  readonly proposal: ProposalView | null
  /** Shown when the pinned answer proposes no unit. */
  readonly noProposal: string | null
  readonly alternatives: ReadonlyArray<{ readonly heading: string; readonly units: ReadonlyArray<{ readonly unitId: string; readonly text: string; readonly order: UnitOrderInput }> }>
  readonly whyNot: ReadonlyArray<{ readonly label: string; readonly reasons: string }>
  readonly deliverTo: ReadonlyArray<{ readonly unitLabel: string; readonly sites: ReadonlyArray<{ readonly siteId: string; readonly text: string; readonly order: UnitOrderInput }> }>
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

/** Why the pinned proposal no longer holds, in the situation's words; null while it holds. */
export const proposalInvalidation = (situation: Situation, answer: RecommendAnswer): string | null => {
  const proposal = answer.proposal
  if (proposal === null) return null
  for (const proposed of proposal.units) {
    const unit = situation.units.find(entry => entry.id === proposed.unitId)
    if (unit === undefined) return `${proposed.label}: ${dispatchWords.notListed.toLowerCase()}`
    const current = unit.plan[0]
    if (current !== undefined) return `${unit.label} now on ${current.label}`
    if (unit.status.tone !== 'free') return `${unit.label} now ${unit.status.word.toLowerCase()}`
  }
  return null
}

const proposalView = (situation: Situation, pinned: PinnedProposal): ProposalView | null => {
  const proposal = pinned.answer.proposal
  if (proposal === null) return null
  const { words } = situation
  const kept = proposal.units.filter(unit => !pinned.dropped.has(unit.unitId))
  const stale = proposalInvalidation(situation, pinned.answer)
  const slowest = Math.max(0, ...kept.map(unit => etaSeconds(unit.eta) ?? 0))
  const label = kept.length === 0 ? words.send : `${words.send} ${joined(kept.map(unit => unit.label))}${slowest > 0 ? ` · ${minutesText(slowest)}` : ''}`
  const reason = stale ?? (kept.length === 0 ? dispatchWords.noUnitChosen : null)
  return {
    button: button(label, reason),
    units: proposal.units.map(unit => ({ unitId: unit.unitId, label: unit.label, eta: etaText(unit.eta), dropped: pinned.dropped.has(unit.unitId) })),
    covers: `covers ${proposal.covers.covered} of ${proposal.covers.needed}`,
    remainder: proposal.remainder.length === 0 ? null : `still needs ${joined(proposal.remainder)}`,
    order: reason === null ? { ...proposal.order, units: proposal.order.units.filter(id => !pinned.dropped.has(id)) } : null,
    stale: stale !== null,
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
    needs: call.needs.map(needText),
    assigned: call.assigned.map(unit => ({
      unitId: unit.unitId,
      text: [unit.label, unit.status.word, ...(unit.eta === null ? [] : [etaText(unit.eta, elapsedS)!]), `by ${unit.by.isViewer ? dispatchWords.you.toLowerCase() : unit.by.label}`].join(' · '),
    })),
    proposal: answer === null ? null : proposalView(situation, answer),
    noProposal: answer !== null && answer.answer.proposal === null ? dispatchWords.noFreeUnit : null,
    alternatives: answer === null ? [] : answer.answer.alternatives.filter(entry => entry.units.length > 0).map(entry => ({
      heading: `Other: ${entry.need.label}`,
      units: entry.units.map(unit => ({ unitId: unit.unitId, text: `${unit.label} · ${etaText(unit.eta)}`, order: unit.order })),
    })),
    whyNot: answer === null ? [] : answer.answer.whyNot.map(entry => ({ label: entry.label, reasons: entry.reasons.join('; ') })),
    // Deliver-to chips show after Dispatch: for the proposed carriers now on this call.
    deliverTo: answer === null ? [] : answer.answer.deliverTo.filter(entry => assignedIds.has(entry.unitId)).map(entry => ({
      unitLabel: entry.label,
      sites: entry.sites.map(site => ({
        siteId: site.siteId,
        text: `${site.label} · ${etaText(site.eta)}`,
        order: { units: [entry.unitId], stops: [{ siteId: site.siteId }], when: 'after' as const },
      })),
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

/** Unassigned and not yet opened by this viewer: the call pulses on the map and carries the New badge. */
export const isNewCall = (call: SituationCall, opened: ReadonlySet<string>): boolean => call.assigned.length === 0 && !opened.has(call.id)

// ——— Site card ———

export interface SiteCardView {
  readonly kind: 'site'
  readonly id: string
  readonly icon: string
  readonly title: string
  readonly accepting: string
  readonly toggle: { readonly label: string; readonly accepting: boolean }
  readonly slots: string
  readonly inbound: ReadonlyArray<string>
  readonly states: ReadonlyArray<string>
}

export const siteCard = (site: SituationSite, elapsedS: number): SiteCardView => {
  const inbound = site.inbound.map(unit => unit.label)
  return {
    kind: 'site',
    id: site.id,
    icon: site.icon,
    title: `${site.label} · ${site.typeLabel}`,
    accepting: site.accepting ? dispatchWords.accepting : dispatchWords.notAccepting,
    toggle: site.accepting
      ? { label: inbound.length === 0 ? dispatchWords.closeArrivals : `${dispatchWords.closeArrivals} (${joined(inbound)} will go elsewhere)`, accepting: false }
      : { label: dispatchWords.openArrivals, accepting: true },
    slots: `${site.slots.used} of ${site.slots.total} ${dispatchWords.slots}`,
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
}

/** The selection block's card; null for S0 (and a marked track). A unit or site the situation no longer lists has no card. */
export const cardFor = (situation: Situation, selection: Selection, inputs: CardInputs): CardView | null => {
  switch (selection.kind) {
    case 'none': return null
    case 'unit':
    case 'armed': {
      const unit = situation.units.find(entry => entry.id === selection.unitId)
      return unit === undefined ? null : unitCard(situation, unit, selection, inputs.options, inputs.elapsedS)
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
  /** One value per property column, in column order; empty where the type has none. */
  readonly properties: ReadonlyArray<string>
  readonly states: ReadonlyArray<string>
  readonly selected: boolean
}

export interface SiteRowView {
  readonly id: string
  readonly icon: string
  readonly label: string
  readonly accepting: string
  readonly slots: string
  readonly inbound: string | null
  readonly states: ReadonlyArray<string>
  readonly selected: boolean
}

export interface OverviewView {
  readonly counts: string
  readonly calls: { readonly heading: string; readonly empty: string | null; readonly rows: ReadonlyArray<CallRowView> }
  readonly units: { readonly heading: string; readonly empty: string | null; readonly groups: ReadonlyArray<{ readonly heading: string; readonly rows: ReadonlyArray<UnitRowView> }> }
  /** Only when some type receives load. */
  readonly sites: { readonly heading: string; readonly rows: ReadonlyArray<SiteRowView> } | null
  readonly columns: { readonly carry: boolean; readonly properties: ReadonlyArray<string> }
  /** Only when some type declares a sensor or an effector. */
  readonly contacts: boolean
  /** While a unit is armed the lists fold to the counts line. */
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

const callRow = (call: SituationCall, opened: ReadonlySet<string>, selectedId: string | null, elapsedS: number): CallRowView => ({
  id: call.id,
  icon: call.icon,
  code: call.priority.code,
  label: call.label,
  waiting: clockText(call.waitingS + elapsedS),
  needs: call.needs.map(need => needText(need).text).join(' · '),
  assigned: call.assigned.length === 0 ? null : joined(call.assigned.map(unit => unit.label)),
  isNew: isNewCall(call, opened),
  overdue: call.overdue === true,
  states: call.states.map(state => state.text),
  selected: call.id === selectedId,
})

const unitRow = (situation: Situation, unit: SituationUnit, selectedId: string | null, elapsedS: number): UnitRowView => {
  const current = unit.plan[0]
  return {
    id: unit.id,
    icon: unit.icon,
    label: unit.label,
    status: unit.status,
    current: current === undefined ? null : [current.label, ...(current.eta === null ? [] : [etaText(current.eta, elapsedS)!])].join(' · '),
    actor: unit.lastOrder === null || unit.lastOrder.by.isViewer ? null : `by ${unit.lastOrder.by.label}`,
    carry: !situation.features.hasCarry || unit.carry === null ? null : `${unit.carry.load.reduce((sum, entry) => sum + entry.count, 0)}/${unit.carry.capacity}`,
    properties: situation.features.propertyColumns.map(column => unit.properties.find(property => property.id === column.id)?.value ?? ''),
    states: unit.states.map(state => state.text),
    selected: unit.id === selectedId,
  }
}

/** Units grouped under their group's label, else their type's, in the situation's order. */
const unitGroups = (situation: Situation, selectedId: string | null, elapsedS: number): OverviewView['units']['groups'] => {
  const groups = new Map<string, UnitRowView[]>()
  for (const unit of situation.units) {
    const heading = unit.group?.label ?? unit.typeLabel
    groups.set(heading, [...(groups.get(heading) ?? []), unitRow(situation, unit, selectedId, elapsedS)])
  }
  return [...groups].map(([heading, rows]) => ({ heading, rows }))
}

const siteRow = (site: SituationSite, selectedId: string | null): SiteRowView => ({
  id: site.id,
  icon: site.icon,
  label: site.label,
  accepting: site.accepting ? dispatchWords.accepting : dispatchWords.notAccepting,
  slots: `${site.slots.used}/${site.slots.total}`,
  inbound: site.inbound.length === 0 ? null : `${dispatchWords.inbound} ${joined(site.inbound.map(unit => unit.label))}`,
  states: site.states.map(state => state.text),
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
    columns: { carry: features.hasCarry, properties: features.propertyColumns.map(column => column.label) },
    contacts: features.hasContacts,
    folded: selection.kind === 'armed',
  }
}

// ——— Armed feedback on the map ———

/**
 * What the map draws while a unit is armed: halos with ETA tags on the
 * nearest valid targets (at most `mapTargetingMaxTargets`), and a refused target's
 * reason at that target while it is shown. Before the options arrive no
 * target carries a tag, but the unit is armed and a click still submits.
 */
export const targetingFor = (selection: Selection, options: UnitOptions | null): MapTargeting | null => {
  if (selection.kind !== 'armed') return null
  const refusal = selection.refusal
  const refused = refusal?.targetId === null || refusal === null ? [] : [{ id: refusal.targetId, tag: refusal.text }]
  const valid = options === null || options.unitId !== selection.unitId ? [] : options.targets.flatMap(target => {
    const id = stopObjectId(target.target)
    return id === null || id === refusal?.targetId ? [] : [{ id, tag: minutesText(target.etaS) }]
  })
  return { from: objectIdSchema.parse(selection.unitId), targets: [...refused, ...valid].slice(0, mapTargetingMaxTargets).map(target => ({ id: objectIdSchema.parse(target.id), tag: target.tag })) }
}

/** The busy prompt's two options, once the unit's options say what its current job is; null until then. */
export const busyPrompt = (options: UnitOptions | null, unitId: string): { readonly after: string; readonly now: string; readonly drops: string } | null => {
  if (options === null || options.unitId !== unitId || options.busy === null) return null
  const busy = options.busy
  const code = options.targets.find(target => target.drops?.taskId === busy.taskId)?.drops?.code
  return {
    after: busy.freeInS === null ? dispatchWords.after : `${dispatchWords.after} (free in ${minutesText(busy.freeInS)})`,
    now: `${dispatchWords.now} (drops ${busy.label}${code === undefined ? '' : ` · ${code}`})`,
    drops: busy.taskId,
  }
}

/** The Move prompt's one option. */
export const movePromptText = (situation: Situation, unitId: string): string => {
  const unit = situation.units.find(entry => entry.id === unitId)
  return `${situation.words.move} ${unit?.label ?? ''} here`.replace(/\s+/g, ' ')
}

// ——— Receipts ———

export interface Receipt {
  readonly commandId: string
  /** The units the order named; Undo takes it back for each. */
  readonly unitIds: ReadonlyArray<string>
  readonly text: string
  /** "Undo (A2 returns to C-3)" when the order dropped a task, else "Undo". */
  readonly undo: string
  readonly atMs: number
}

/** A receipt of this viewer's own accepted order, naming what it dropped. */
export const ownReceipt = (options: { readonly commandId: string; readonly unitIds: ReadonlyArray<string>; readonly unitLabel: string; readonly targetLabel: string; readonly dropped: string | null; readonly atMs: number }): Receipt => ({
  commandId: options.commandId,
  unitIds: options.unitIds,
  text: `${dispatchWords.you}: ${options.unitLabel} → ${options.targetLabel}${options.dropped === null ? '' : ` (drops ${options.dropped})`}`,
  undo: options.dropped === null ? dispatchWords.undo : `${dispatchWords.undo} (${options.unitLabel} returns to ${options.dropped})`,
  atMs: options.atMs,
})

/** Receipts of orders the situation shows as new since the previous read: another actor's, or this viewer's from another surface. */
export const receiptsFromSituation = (previous: Situation | null, next: Situation, atMs: number): ReadonlyArray<Receipt> => {
  if (previous === null) return []
  const before = new Map(previous.units.map(unit => [unit.id, unit.lastOrder?.commandId ?? null]))
  return next.units.flatMap(unit => {
    const commandId = unit.lastOrder?.commandId ?? null
    if (commandId === null || unit.lastOrder === null || before.get(unit.id) === commandId) return []
    const target = unit.plan[0]?.label ?? unit.status.word
    return [{ commandId, unitIds: [unit.id], text: `${actorText(unit.lastOrder.by)}: ${unit.label} → ${target}`, undo: dispatchWords.undo, atMs }]
  })
}

/** Adds receipts, newest on top; one per command, at most `maxReceipts`. */
export const withReceipts = (list: ReadonlyArray<Receipt>, added: ReadonlyArray<Receipt>): ReadonlyArray<Receipt> => {
  const known = new Set(list.map(receipt => receipt.commandId))
  const fresh = added.filter(receipt => !known.has(receipt.commandId))
  return [...fresh.reverse(), ...list].slice(0, maxReceipts)
}

/** Whether a receipt still offers Undo. */
export const receiptUndoable = (receipt: Receipt, nowMs: number): boolean => nowMs - receipt.atMs < receiptUndoMs

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
