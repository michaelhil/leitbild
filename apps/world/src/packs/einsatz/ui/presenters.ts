import { z } from 'zod'
import { objectIdSchema, type OperationalObject } from '../../../core/model/index.ts'
import { einsatzPackId } from '../ids.ts'
import { neutralLexicon, unitPhases } from '../lexicon.ts'
import type { Stop, UnitOrderInput } from '../order-schema.ts'
import type { Eta, RecommendAnswer } from '../recommendation-schema.ts'
import type { Situation, SituationCall, SituationSite, SituationUnit, StopVerb, UnitOptions, UnitTone } from '../situation/schema.ts'
import { mapTargetingMaxTargets, type MapTargeting } from '../../../ui/surface-panel-interaction.ts'
import { selectedObjectOf, stopObjectId, type CurrentJob, type DispatchObjectKind, type Selection } from './selection.ts'

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
  loadingTargets: 'Reading targets… a click on the map still sends',
  readingJob: 'Reading the current job…',
  refreshing: 'Reading the suggestion again…',
  suggestionHolds: 'The suggestion still holds',
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

/**
 * The armed list's rows in a fixed order, so a live update never moves a
 * row under the pointer: the order of the first options answer after
 * arming (valid targets nearest first, then refused ones), with every target
 * a later answer adds appended. Each row keeps the label it was last listed
 * with, for a target no answer lists any more.
 */
export interface ArmedOrder {
  readonly unitId: string
  readonly rows: ReadonlyArray<{ readonly key: string; readonly target: Stop; readonly label: string }>
}

const stopKey = (target: Stop): string => JSON.stringify(target)

/** The armed list's order after this options answer: the rows so far in place, new targets appended; a new unit starts afresh. */
export const armedOrderWith = (order: ArmedOrder | null, options: UnitOptions): ArmedOrder => {
  const listed = [...options.targets, ...options.refused].map(entry => ({ key: stopKey(entry.target), target: entry.target, label: entry.label }))
  const kept = order !== null && order.unitId === options.unitId ? order.rows : []
  const labels = new Map(listed.map(row => [row.key, row.label]))
  const known = new Set(kept.map(row => row.key))
  return {
    unitId: options.unitId,
    rows: [...kept.map(row => ({ ...row, label: labels.get(row.key) ?? row.label })), ...listed.filter(row => !known.has(row.key))],
  }
}

export interface ArmedRowView {
  readonly key: string
  readonly target: Stop
  /** The verb and label, or the label alone for a refused target. */
  readonly text: string
  /** The ETA of a valid target; null for a refused one. */
  readonly eta: string | null
  /** "drops C-3 · P3" for a busy unit's current task. */
  readonly drops: string | null
  /** Why an order to it is refused, for a dimmed row that still submits; null for a valid one. */
  readonly refused: string | null
}

/**
 * The armed card's reserved slot above its rows, which holds one thing at a
 * time so the rows below never move: the busy prompt's choices (or, until
 * the options name the current job, a note), else the last refusal.
 */
export type ArmedSlot =
  | { readonly kind: 'empty' }
  | { readonly kind: 'refusal'; readonly text: string }
  | { readonly kind: 'busy-reading' }
  | { readonly kind: 'busy'; readonly after: string; readonly now: string }

export interface ArmedView {
  readonly banner: string
  readonly slot: ArmedSlot
  readonly rows: ReadonlyArray<ArmedRowView>
  /** True while the unit's options are on their way; a target click still submits. */
  readonly loading: boolean
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
  /** "Undo last order (by Assistant: C-2 → Triage post)": who gave the order it takes back, and where it sent the unit. */
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

/** The job a busy unit's options name, with its priority code where a target names it. */
export const currentJobOf = (options: UnitOptions): CurrentJob | null => {
  const busy = options.busy
  if (busy === null) return null
  const code = options.targets.find(target => target.drops?.taskId === busy.taskId)?.drops?.code ?? null
  return { taskId: busy.taskId, label: busy.label, code, freeInS: busy.freeInS }
}

/** The busy prompt's two options, labelled from the job the prompt named when it opened. */
export const busyChoices = (job: CurrentJob): { readonly after: string; readonly now: string } => ({
  after: job.freeInS === null ? dispatchWords.after : `${dispatchWords.after} (free in ${minutesText(job.freeInS)})`,
  now: `${dispatchWords.now} (drops ${job.label}${job.code === null ? '' : ` · ${job.code}`})`,
})

const armedSlot = (selection: Extract<Selection, { kind: 'armed' }>): ArmedSlot => {
  const prompt = selection.prompt
  if (prompt?.kind === 'busy') return prompt.job === null ? { kind: 'busy-reading' } : { kind: 'busy', ...busyChoices(prompt.job) }
  return selection.refusal === null ? { kind: 'empty' } : { kind: 'refusal', text: selection.refusal.text }
}

const armedView = (unit: SituationUnit, words: Words, options: UnitOptions | null, order: ArmedOrder | null, selection: Extract<Selection, { kind: 'armed' }>): ArmedView => {
  const own = options !== null && options.unitId === unit.id ? options : null
  const valid = new Map((own?.targets ?? []).map(target => [stopKey(target.target), target]))
  const refused = new Map((own?.refused ?? []).map(entry => [stopKey(entry.target), entry]))
  const rows = order !== null && order.unitId === unit.id ? order.rows : []
  return {
    banner: `${words.send} ${unit.label}…${selection.when === 'after' ? ` (${dispatchWords.after.toLowerCase()})` : ''}`,
    slot: armedSlot(selection),
    rows: rows.map(row => {
      const target = valid.get(row.key)
      if (target !== undefined) {
        return { key: row.key, target: row.target, text: `${verbText(target.verb, words)} ${target.label}`, eta: minutesText(target.etaS), drops: target.drops === undefined ? null : `drops ${target.drops.label} · ${target.drops.code}`, refused: null }
      }
      return { key: row.key, target: row.target, text: row.label, eta: null, drops: null, refused: refused.get(row.key)?.text ?? dispatchWords.notListed }
    }),
    loading: own === null,
  }
}

/** Who gave the unit's last order and where it sent the unit: the stops that actor gave, else the unit's status. */
const lastOrderText = (unit: SituationUnit): string | null => {
  const last = unit.lastOrder
  if (last === null) return null
  const stops = unit.plan.filter(stop => stop.by.isViewer === last.by.isViewer && stop.by.label === last.by.label).map(stop => stop.label)
  return `by ${last.by.isViewer ? dispatchWords.you.toLowerCase() : last.by.label}: ${stops.length === 0 ? unit.status.word : stops.join(' → ')}`
}

/** A unit's card, armed or not. */
export const unitCard = (situation: Situation, unit: SituationUnit, selection: Selection, options: UnitOptions | null, order: ArmedOrder | null, elapsedS: number): UnitCardView => {
  const { words } = situation
  const readOnly = unit.commandedBy === null ? null : `Commanded by ${unit.commandedBy}`
  const destroyed = unit.status.tone === 'out' ? unit.status.word : null
  const loaded = loadLabels(unit)
  const tasks = taskStopLabels(unit)
  const recallLabel = tasks.length === 0 ? words.return : `${words.return} (drops ${joined(tasks)})`
  const lastCommand = unit.lastOrder?.commandId ?? null
  const lastOrder = lastOrderText(unit)
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
    undo: { ...button(lastOrder === null ? dispatchWords.undoLast : `${dispatchWords.undoLast} (${lastOrder})`, readOnly ?? (lastCommand === null ? dispatchWords.nothingToUndo : null)), commandId: lastCommand },
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
    armed: selection.kind === 'armed' && selection.unitId === unit.id ? armedView(unit, words, options, order, selection) : null,
  }
}

/** The order a Deliver-to chip of the unit card sends: a site stop after the unit's plan. */
export const deliverToOrder = (unit: SituationUnit, siteId: string): UnitOrderInput => ({
  units: [unit.id],
  stops: [{ siteId }],
  ...(unit.plan.length > 0 ? { when: 'after' as const } : {}),
})

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
  readonly enabled: boolean
  readonly sites: ReadonlyArray<{ readonly siteId: string; readonly text: string; readonly order: UnitOrderInput }>
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

const proposalView = (situation: Situation, pinned: PinnedProposal | null): ProposalView => {
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
      : proposal === null ? dispatchWords.noFreeUnit : stale ?? (kept.length === 0 ? dispatchWords.noUnitChosen : null)
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
    proposal: proposalView(situation, answer),
    deliverTo: answer === null ? [] : answer.answer.deliverTo.map(entry => {
      const enabled = live && assignedIds.has(entry.unitId)
      return {
        unitLabel: entry.label,
        heading: enabled ? `${dispatchWords.deliverTo} (${entry.label})` : `${dispatchWords.deliverTo} (${entry.label}, after ${words.send})`,
        enabled,
        sites: entry.sites.map(site => ({
          siteId: site.siteId,
          text: `${site.label} · ${etaText(site.eta)}`,
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
      text: [unit.label, unit.status.word, ...(unit.eta === null ? [] : [etaText(unit.eta, elapsedS)!]), `by ${unit.by.isViewer ? dispatchWords.you.toLowerCase() : unit.by.label}`].join(' · '),
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
  /** The armed list's order, fixed at arming. */
  readonly armedOrder: ArmedOrder | null
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
      return unit === undefined ? null : unitCard(situation, unit, selection, inputs.options, inputs.armedOrder, inputs.elapsedS)
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
  /** "Water 3,000 l" per property column, in column order, label and value as the card shows them; none where the type has none. */
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
  readonly columns: { readonly carry: boolean }
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
    properties: situation.features.propertyColumns.flatMap(column => unit.properties.filter(property => property.id === column.id).map(property => `${property.label} ${property.value}`)),
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
    columns: { carry: features.hasCarry },
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
  /** This viewer's own order, from its own result: it names what the order dropped, which the situation cannot. */
  readonly own: boolean
}

/** A receipt of this viewer's own accepted order, naming what it dropped. */
export const ownReceipt = (options: { readonly commandId: string; readonly unitIds: ReadonlyArray<string>; readonly unitLabel: string; readonly targetLabel: string; readonly dropped: string | null; readonly atMs: number }): Receipt => ({
  commandId: options.commandId,
  unitIds: options.unitIds,
  text: `${dispatchWords.you}: ${options.unitLabel} → ${options.targetLabel}${options.dropped === null ? '' : ` (drops ${options.dropped})`}`,
  undo: options.dropped === null ? dispatchWords.undo : `${dispatchWords.undo} (${options.unitLabel} returns to ${options.dropped})`,
  atMs: options.atMs,
  own: true,
})

/** Receipts of orders the situation shows as new since the previous read: another actor's, or this viewer's from another surface. */
export const receiptsFromSituation = (previous: Situation | null, next: Situation, atMs: number): ReadonlyArray<Receipt> => {
  if (previous === null) return []
  const before = new Map(previous.units.map(unit => [unit.id, unit.lastOrder?.commandId ?? null]))
  return next.units.flatMap(unit => {
    const commandId = unit.lastOrder?.commandId ?? null
    if (commandId === null || unit.lastOrder === null || before.get(unit.id) === commandId) return []
    const target = unit.plan[0]?.label ?? unit.status.word
    return [{ commandId, unitIds: [unit.id], text: `${actorText(unit.lastOrder.by)}: ${unit.label} → ${target}`, undo: dispatchWords.undo, atMs, own: false }]
  })
}

/**
 * Adds receipts, newest on top; one per command, at most `maxReceipts`. A
 * viewer's own receipt takes the place of the situation's for the same
 * command, whichever arrived first, so what it names is never lost; it
 * keeps that place and Undo window.
 */
export const withReceipts = (list: ReadonlyArray<Receipt>, added: ReadonlyArray<Receipt>): ReadonlyArray<Receipt> => {
  const ownOf = new Map(added.filter(receipt => receipt.own).map(receipt => [receipt.commandId, receipt]))
  const kept = list.map(receipt => {
    const own = receipt.own ? undefined : ownOf.get(receipt.commandId)
    return own === undefined ? receipt : { ...own, atMs: receipt.atMs }
  })
  const known = new Set(list.map(receipt => receipt.commandId))
  const fresh = added.filter(receipt => !known.has(receipt.commandId))
  return [...fresh.reverse(), ...kept].slice(0, maxReceipts)
}

/** Whether a receipt still offers Undo. */
export const receiptUndoable = (receipt: Receipt, nowMs: number): boolean => nowMs - receipt.atMs < receiptUndoMs

// ——— Re-layout ———

const cardLayout = (card: CardView | null): ReadonlyArray<unknown> => {
  if (card === null) return ['none']
  switch (card.kind) {
    case 'unit': return card.armed === null
      ? ['unit', card.id, card.plan.map(stop => stop.id), card.predicted !== null, card.deliverTo.length, card.addStop !== null, card.states.length]
      : ['armed', card.id, card.armed.slot.kind, card.armed.loading, card.armed.rows.map(row => row.key), card.plan.map(stop => stop.id)]
    case 'call': return ['call', card.id, card.proposal.units.length, card.proposal.waiting, card.deliverTo.map(entry => [entry.enabled, entry.sites.length]), card.alternatives.map(entry => entry.units.length), card.whyNot.length > 0, card.assigned.length, card.states.length]
    case 'closed-call': return ['closed-call', card.id]
    case 'site': return ['site', card.id, card.inbound.length, card.states.length]
  }
}

/**
 * Where the panel's commands stand: which card shows and in which form,
 * what its slots and lists hold, the receipts, and the rows of the lists.
 * A change of it is a re-layout, after which no command acts for the
 * double-click interval (`activationActs`), so a second tap never lands on
 * what moved under it. A clock or an ETA running on, or a word changing in
 * place, moves nothing and is none.
 */
export const panelLayoutKey = (card: CardView | null, view: OverviewView | null, receipts: ReadonlyArray<Receipt>, confirming: boolean): string => JSON.stringify([
  cardLayout(card),
  confirming,
  receipts.map(receipt => receipt.commandId),
  view === null ? null : [
    view.folded,
    view.calls.rows.map(row => [row.id, row.states.length]),
    view.units.groups.map(group => group.rows.map(row => [row.id, row.states.length, row.current !== null || row.actor !== null])),
    view.sites?.rows.map(row => [row.id, row.states.length, row.inbound !== null]) ?? null,
  ],
])

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
