import type { GeoJsonPoint } from '../../../core/model/index.ts'
import type { OrderWhen, Stop } from '../order-schema.ts'
import type { UnitOptions } from '../situation/schema.ts'

/**
 * What a click does in the Dispatch panel: the plan's selection table (B.3)
 * as a pure reducer. Clicking shows; only a labelled verb commands. A
 * selected unit never sends anything by itself, so a click made to look
 * never dispatches; only an armed unit ("Dispatch A4…") turns a target
 * click into an order, and then every target click submits, whatever the
 * glow said, because the server decides.
 *
 * States: S0 nothing selected (`none`, which may mark a track the map
 * rings), SU a unit's card (`unit`), SA that unit armed (`armed`), SC a
 * call's card (`call`), SS a site's card (`site`).
 *
 * Every click reaches the reducer as a `click`, whether the map selected
 * the object, handed it to the panel as a map target of the selected unit,
 * or a row in the panel was tapped. Double-clicks act as one click: a second
 * map click on the same object or the ground within `doubleClickMs` is a
 * no-op, and the panel lets no card, row or footer command act within
 * `doubleClickMs` of the last one that acted (`activationActs`), so the
 * second half of a double-click never lands on whatever took the first
 * one's place. Any other click acts, however recently the panel changed.
 * Esc, the banner's × and the card's × go one level back (`back`).
 *
 * The reducer returns its effects; the panel performs them in order:
 * `select` shares the selection with the map, `submit` sends a
 * `world.einsatz.unit.order` for the armed unit, `options` reads
 * `world.einsatz.unit.options` for a unit whose card opens and again when
 * it is armed, `recommend` pins the call card's
 * proposal and `late-refusal` reports a refused order whose unit is no
 * longer armed, which would otherwise be lost. An armed unit holds its
 * latest options read, from the one its card held at arming on, so its
 * first tap is judged by them as every later one is.
 */

/** A second click on the same thing within this many ms is the second half of a double-click. */
export const doubleClickMs = 500
/** How long a refused target's reason stays beside it. */
export const refusalShownMs = 4_000

export const dispatchObjectKinds = ['unit', 'call', 'site', 'track'] as const
export type DispatchObjectKind = typeof dispatchObjectKinds[number]

/** An Einsatz object a click lands on, by what it is to the panel. */
export interface ClickedObject {
  readonly id: string
  readonly kind: DispatchObjectKind
}

export type Clicked = ClickedObject | { readonly kind: 'ground'; readonly point: GeoJsonPoint }

/** A busy unit's current job, as its options name it (`busy`): the task an order with `when: 'now'` drops. */
export type CurrentJob = NonNullable<UnitOptions['busy']>

/** A row of the armed list, by the target it names, with the label it was last listed with. */
export interface ArmedRow {
  readonly key: string
  readonly target: Stop
  readonly label: string
}

const stopKey = (target: Stop): string => JSON.stringify(target)

/**
 * The armed list's rows after this options answer, in a fixed order so a
 * live update never moves a row under the pointer: the rows so far in
 * place, each with its latest label, and every target the answer adds
 * appended (the first answer's order: valid targets nearest first, then
 * refused ones). A row no answer lists any more keeps its last label.
 */
export const armedRowsWith = (rows: ReadonlyArray<ArmedRow>, options: UnitOptions): ReadonlyArray<ArmedRow> => {
  const listed = [...options.targets, ...options.refused].map(entry => ({ key: stopKey(entry.target), target: entry.target, label: entry.label }))
  const labels = new Map(listed.map(row => [row.key, row.label]))
  const known = new Set(rows.map(row => row.key))
  return [...rows.map(row => ({ ...row, label: labels.get(row.key) ?? row.label })), ...listed.filter(row => !known.has(row.key))]
}

/** A prompt the map shows for the armed unit, offset from the point it names. */
export type ArmedPrompt =
  /** A tap on open ground: "Move A4 here". */
  | { readonly kind: 'move'; readonly point: GeoJsonPoint }
  /**
   * A target tapped for a busy unit: "After current job" or "Now (drops
   * …)". It opens on the tap, from the job the unit's options read named;
   * when that read had not arrived, or called the unit free, the tap
   * submits and the server's `when_required` opens it, with the job the
   * options name next. The job stays the one it opened with: the prompt
   * never re-labels under the pointer, and "Now" sends exactly the task it
   * names, so the server's `drops_mismatch` catches a job that changed
   * meanwhile. Null until the options name it; "Now" is not offered before.
   */
  | { readonly kind: 'busy'; readonly target: Stop; readonly job: CurrentJob | null }

/** A refusal shown beside its target (and in the card) until `untilMs`. */
export interface ShownRefusal {
  /** The object the refused stop names; null for a point. */
  readonly targetId: string | null
  readonly text: string
  readonly untilMs: number
}

export type Selection =
  | { readonly kind: 'none'; readonly marked: string | null }
  | { readonly kind: 'unit'; readonly unitId: string }
  | {
    readonly kind: 'armed'
    readonly unitId: string
    /** `after` when armed by "+ Add stop", so no busy prompt appears. */
    readonly when: 'after' | null
    readonly prompt: ArmedPrompt | null
    readonly refusal: ShownRefusal | null
    /**
     * The unit's latest options read: its current job (`busy`) and the
     * targets a tap may take. Null until one for this unit is held; a tap
     * then submits, and the server decides.
     */
    readonly options: UnitOptions | null
    /** The armed list's rows, in the order fixed at arming (`armedRowsWith`). */
    readonly rows: ReadonlyArray<ArmedRow>
  }
  | { readonly kind: 'call'; readonly callId: string }
  | { readonly kind: 'site'; readonly siteId: string }

export interface SelectionState {
  readonly selection: Selection
  /** The last click that acted, for double-click detection. */
  readonly lastClick: { readonly key: string; readonly atMs: number } | null
}

/** What a submitted order came back with, as the panel's client reads it. */
export type SubmitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string | null; readonly text: string }

export type SelectionEvent =
  | { readonly kind: 'click'; readonly on: Clicked; readonly atMs: number }
  /** A row of the armed card's target list: it submits like its map target. */
  | { readonly kind: 'target-row'; readonly target: Stop }
  /** "Dispatch A4…", or "+ Add stop" with `when: 'after'`; `held` is the options read the panel holds, which count when they are this unit's. */
  | { readonly kind: 'arm'; readonly unitId: string; readonly when: 'after' | null; readonly held: UnitOptions | null }
  /** A choice of the armed unit's map prompt. */
  | { readonly kind: 'prompt'; readonly choice: 'move' | OrderWhen }
  /**
   * The operator dismissed the map prompt without confirming: a map click
   * elsewhere, its × or Esc. The surface has dropped it; the unit stays
   * armed and the prompt is gone, so it is never shown again. A click that
   * dismissed it reaches the table after this, as any click does.
   */
  | { readonly kind: 'prompt-dismissed' }
  | { readonly kind: 'back' }
  /** The surface cleared the shared selection. */
  | { readonly kind: 'cleared' }
  | { readonly kind: 'result'; readonly unitId: string; readonly target: Stop; readonly outcome: SubmitOutcome; readonly atMs: number }
  /** A unit's options arrived: they name its current job (`busy`), or none while it is free, and its targets. */
  | { readonly kind: 'options-read'; readonly options: UnitOptions }
  | { readonly kind: 'tick'; readonly atMs: number }

export type SelectionEffect =
  | { readonly kind: 'select'; readonly objectId: string | null }
  /** `drops` goes with `when: 'now'`: the job the busy prompt named. */
  | { readonly kind: 'submit'; readonly unitId: string; readonly target: Stop; readonly when: OrderWhen | null; readonly drops: CurrentJob | null }
  | { readonly kind: 'options'; readonly unitId: string }
  | { readonly kind: 'recommend'; readonly callId: string }
  /** A refused order of a unit the selection has left: the panel reports it, since no target shows it any more. */
  | { readonly kind: 'late-refusal'; readonly unitId: string; readonly target: Stop; readonly text: string }

export interface SelectionStep {
  readonly state: SelectionState
  readonly effects: ReadonlyArray<SelectionEffect>
}

export const initialSelection: SelectionState = { selection: { kind: 'none', marked: null }, lastClick: null }

const none: Selection = { kind: 'none', marked: null }

/** The object the selection shows, which the map selects too. */
export const selectedObjectOf = (selection: Selection): string | null => {
  switch (selection.kind) {
    case 'none': return selection.marked
    case 'unit':
    case 'armed': return selection.unitId
    case 'call': return selection.callId
    case 'site': return selection.siteId
  }
}

/** The stop a target object names: a call is served or picked up from, a site delivered to or gone to, a track engaged. */
export const stopFor = (object: ClickedObject): Stop | null => {
  switch (object.kind) {
    case 'call': return { taskId: object.id }
    case 'site': return { siteId: object.id }
    case 'track': return { trackId: object.id }
    case 'unit': return null
  }
}

/** The object a stop names; a point names none. */
export const stopObjectId = (stop: Stop): string | null =>
  'taskId' in stop ? stop.taskId : 'siteId' in stop ? stop.siteId : 'trackId' in stop ? stop.trackId : null

const clickKey = (on: Clicked): string => on.kind === 'ground' ? 'ground' : `${on.kind}:${on.id}`

const cardOf = (object: ClickedObject): Selection => {
  switch (object.kind) {
    case 'unit': return { kind: 'unit', unitId: object.id }
    case 'call': return { kind: 'call', callId: object.id }
    case 'site': return { kind: 'site', siteId: object.id }
    case 'track': return { kind: 'none', marked: object.id }
  }
}

/**
 * The effects of moving from one selection to the next: the map follows, a
 * unit whose card opens reads its options, which say whether any order can
 * be given to it, and reads them again when it is armed, so the targets and
 * its current job are fresh; a newly opened call card pins its proposal.
 */
const transition = (state: SelectionState, next: Selection, extra: ReadonlyArray<SelectionEffect> = []): SelectionStep => {
  const before = state.selection
  const effects: SelectionEffect[] = []
  const objectId = selectedObjectOf(next)
  if (objectId !== selectedObjectOf(before)) effects.push({ kind: 'select', objectId })
  const unitId = next.kind === 'unit' || next.kind === 'armed' ? next.unitId : null
  const shown = before.kind === 'unit' || before.kind === 'armed' ? before.unitId : null
  if (unitId !== null && (unitId !== shown || (next.kind === 'armed' && before.kind !== 'armed'))) effects.push({ kind: 'options', unitId })
  if (next.kind === 'call' && (before.kind !== 'call' || before.callId !== next.callId)) effects.push({ kind: 'recommend', callId: next.callId })
  return { state: { ...state, selection: next }, effects: [...effects, ...extra] }
}

const unchanged = (state: SelectionState): SelectionStep => ({ state, effects: [] })

/**
 * A target for the armed unit. A unit its options read names busy asks
 * After or Now at once, sending nothing yet; any other submits, and the
 * server decides: a target its options say only an order "after" its plan
 * takes (a loaded carrier's call) with `when: 'after'`, since nothing is
 * dropped and nothing needs asking, any other as armed. The prompt shown
 * goes: this tap answers what it asked. A refusal shown stays until the
 * result replaces it or it expires.
 */
const submit = (state: SelectionState, armed: Extract<Selection, { kind: 'armed' }>, target: Stop): SelectionStep => {
  const job = armed.options?.busy ?? null
  if (armed.when === null && job !== null) return { state: { ...state, selection: { ...armed, prompt: { kind: 'busy', target, job } } }, effects: [] }
  const afterOnly = armed.options?.targets.some(entry => !entry.now && stopKey(entry.target) === stopKey(target)) === true
  const when = armed.when ?? (afterOnly ? 'after' : null)
  return { state: { ...state, selection: { ...armed, prompt: null } }, effects: [{ kind: 'submit', unitId: armed.unitId, target, when, drops: null }] }
}

const clickIn = (state: SelectionState, on: Clicked): SelectionStep => {
  const selection = state.selection
  if (on.kind === 'ground') {
    if (selection.kind === 'armed') return { state: { ...state, selection: { ...selection, prompt: { kind: 'move', point: on.point } } }, effects: [] }
    return transition(state, none)
  }
  if (on.kind === 'unit') {
    // The same unit: a no-op in its card and while it is armed; any other unit opens its card (and disarms).
    if ((selection.kind === 'unit' || selection.kind === 'armed') && selection.unitId === on.id) return unchanged(state)
    return transition(state, cardOf(on))
  }
  if (selection.kind === 'armed') {
    const target = stopFor(on)
    if (target === null) throw new Error(`A ${on.kind} is no stop: ${on.id}`)
    return submit(state, selection, target)
  }
  // A call, site or track opens its card (a track is marked), never sends; the same one again is a no-op.
  return transition(state, cardOf(on))
}

/** One step of the selection table. */
export const reduceSelection = (state: SelectionState, event: SelectionEvent): SelectionStep => {
  const selection = state.selection
  switch (event.kind) {
    case 'click': {
      const key = clickKey(event.on)
      const last = state.lastClick
      if (last !== null && last.key === key && event.atMs - last.atMs < doubleClickMs) return unchanged(state)
      return clickIn({ ...state, lastClick: { key, atMs: event.atMs } }, event.on)
    }
    case 'target-row':
      if (selection.kind !== 'armed') throw new Error('A target row was tapped while no unit is armed')
      return submit(state, selection, event.target)
    case 'arm': {
      const options = event.held !== null && event.held.unitId === event.unitId ? event.held : null
      return transition(state, { kind: 'armed', unitId: event.unitId, when: event.when, prompt: null, refusal: null, options, rows: options === null ? [] : armedRowsWith([], options) })
    }
    case 'prompt': {
      if (selection.kind !== 'armed' || selection.prompt === null) throw new Error(`The ${event.choice} prompt was confirmed with no prompt shown`)
      const prompt = selection.prompt
      if (prompt.kind === 'move') {
        if (event.choice !== 'move') throw new Error(`The move prompt offers no ${event.choice}`)
        return submit(state, selection, { point: prompt.point })
      }
      if (event.choice === 'move') throw new Error('The busy prompt offers no move')
      if (event.choice === 'now' && prompt.job === null) throw new Error('The busy prompt\'s Now was confirmed before the unit\'s current job was known')
      const drops = event.choice === 'now' ? prompt.job : null
      return { state: { ...state, selection: { ...selection, prompt: null } }, effects: [{ kind: 'submit', unitId: selection.unitId, target: prompt.target, when: event.choice, drops }] }
    }
    case 'prompt-dismissed':
      return selection.kind === 'armed' && selection.prompt !== null ? { state: { ...state, selection: { ...selection, prompt: null } }, effects: [] } : unchanged(state)
    case 'back':
      switch (selection.kind) {
        case 'none': return selection.marked === null ? unchanged(state) : transition(state, none)
        case 'armed': return transition(state, { kind: 'unit', unitId: selection.unitId })
        default: return transition(state, none)
      }
    case 'cleared':
      return { state: { ...state, selection: none }, effects: [] }
    case 'result': {
      const outcome = event.outcome
      if (selection.kind !== 'armed' || selection.unitId !== event.unitId) {
        return outcome.ok ? unchanged(state) : { state, effects: [{ kind: 'late-refusal', unitId: event.unitId, target: event.target, text: outcome.text }] }
      }
      if (outcome.ok) return transition(state, { kind: 'unit', unitId: selection.unitId })
      if (outcome.code === 'when_required') {
        return { state: { ...state, selection: { ...selection, prompt: { kind: 'busy', target: event.target, job: null }, refusal: null } }, effects: [{ kind: 'options', unitId: selection.unitId }] }
      }
      const refusal: ShownRefusal = { targetId: stopObjectId(event.target), text: outcome.text, untilMs: event.atMs + refusalShownMs }
      return { state: { ...state, selection: { ...selection, refusal } }, effects: [] }
    }
    case 'options-read': {
      const options = event.options
      if (selection.kind !== 'armed' || selection.unitId !== options.unitId) return unchanged(state)
      // An open busy prompt that has not yet named its job takes this one; from then on it keeps it.
      const prompt = selection.prompt?.kind === 'busy' && selection.prompt.job === null && options.busy !== null ? { ...selection.prompt, job: options.busy } : selection.prompt
      return { state: { ...state, selection: { ...selection, options, rows: armedRowsWith(selection.rows, options), prompt } }, effects: [] }
    }
    case 'tick':
      if (selection.kind === 'armed' && selection.refusal !== null && event.atMs >= selection.refusal.untilMs) {
        return { state: { ...state, selection: { ...selection, refusal: null } }, effects: [] }
      }
      return unchanged(state)
  }
}

/**
 * Whether a card, row or footer command acts at `atMs`: not when it is the
 * second half of a double-click, within `doubleClickMs` of `quietFromMs`,
 * when the last command acted; null before any did.
 */
export const activationActs = (quietFromMs: number | null, atMs: number): boolean => quietFromMs === null || atMs - quietFromMs >= doubleClickMs

/**
 * The shared selection moved outside the panel (the map selected an object,
 * or cleared): the click it stands for, or `cleared`; null when it is the
 * object the panel shows already, which is how the panel's own `select`
 * effects come back.
 */
export const selectionChangeEvent = (state: SelectionState, objectId: string | null, kindOf: (objectId: string) => DispatchObjectKind | null, atMs: number): SelectionEvent | null => {
  if (objectId === selectedObjectOf(state.selection)) return null
  if (objectId === null) return { kind: 'cleared' }
  const kind = kindOf(objectId)
  // Another Pack's object: the panel shows nothing for it.
  if (kind === null) return { kind: 'cleared' }
  return { kind: 'click', on: { id: objectId, kind }, atMs }
}
