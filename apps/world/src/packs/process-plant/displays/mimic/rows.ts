import type { MimicFlowBinding, MimicItemBinding } from './bindings.ts'
import { flowLook, itemLook, type FlowLook, type ItemLook, type SampleIndex } from './evaluate.ts'
import type { MimicPresentation } from './presentation.ts'

// The text rows beside a drawn item, shared by the server (which reserves
// their room before any sample exists) and the embed (which fills them). A
// row's possible texts are known in advance, so the drawing never moves when
// a state changes; an abnormal row (STOP, POS ?, a disagreeing command) is
// never dropped to make room.

export type MimicRow =
  /** A value with its unit, from a key value or a valve's partial opening. */
  | { readonly kind: 'value'; readonly path: string; readonly unit: string; readonly required: boolean }
  | { readonly kind: 'position'; readonly required: true }
  /** The state in a word where the symbol alone could be misread: STOP, ?, DEAD, POS ?. */
  | { readonly kind: 'state'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** What passes an item whose position is not computed: PASSING or NO FLOW. */
  | { readonly kind: 'throughput'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** A command the item does not follow: CMD 100 %, CMD RUN, CMD SHUT. */
  | { readonly kind: 'mismatch'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /**
   * A valve marker's one row, empty while the valve is quiet. It says, first
   * that applies: a command it does not follow (CMD SHUT), that its position
   * is not known (POS ?), or its opening while it stands between shut and
   * open (40 %).
   */
  | { readonly kind: 'marker'; readonly texts: ReadonlyArray<string>; readonly required: true }
  /** Grouped parallel equipment: how many members are in the state the group is drawn by ("1/2 RUN"). */
  | { readonly kind: 'count'; readonly members: ReadonlyArray<MimicItemBinding>; readonly word: string; readonly texts: ReadonlyArray<string>; readonly required: true }

const POSITION_COMMANDS = ['CMD SHUT', 'CMD OPEN', 'CMD 100 %', 'CMD 10 %']
const RUNNING_COMMANDS = ['CMD RUN', 'CMD STOP']
/** A digital valve reads shut below and open above these positions (evaluate.ts); between, a marker shows its opening. */
const SHUT_BELOW = 0.05
const OPEN_ABOVE = 0.95
/** The widest opening a marker can show. */
const WIDEST_OPENING = '95 %'

/** The word a group counts its members by, per state aspect; aspects without one are not grouped. */
export const COUNT_WORDS: Readonly<Partial<Record<string, string>>> = { running: 'RUN', energized: 'LIVE', position: 'OPEN' }

const countTexts = (members: number, word: string): ReadonlyArray<string> => [`${members}/${members} ${word}`, `${members}/${members} ${word} ?`]

/**
 * The rows beside an item. A valve drawn as a marker has one row; a group of
 * parallel members has its count, and a disagreeing command of any member.
 */
export const itemRows = (binding: MimicItemBinding, presentation: MimicPresentation, options: { readonly marker: boolean; readonly members: ReadonlyArray<MimicItemBinding> }): ReadonlyArray<MimicRow> => {
  if (options.members.length > 1) {
    const aspect = binding.state?.aspect
    const word = aspect === undefined ? undefined : COUNT_WORDS[aspect]
    if (word === undefined) throw new Error(`a group of ${binding.label} has no state to count its members by`)
    const commanded = options.members.some(member => member.state?.command !== undefined)
    return [
      { kind: 'count', members: options.members, word, texts: countTexts(options.members.length, word), required: true },
      ...(commanded ? [{ kind: 'mismatch' as const, texts: aspect === 'running' ? RUNNING_COMMANDS : POSITION_COMMANDS, required: true as const }] : []),
    ]
  }
  if (options.marker) return [{ kind: 'marker', texts: [...POSITION_COMMANDS, 'POS ?', WIDEST_OPENING], required: true }]
  const state = binding.state
  const values: ReadonlyArray<MimicRow> = binding.values.map((value, index) => ({ kind: 'value', path: value.path, unit: value.unit, required: index === 0 }))
  if (presentation.element !== 'device' || state === null) return values
  if (state.aspect === 'running') return [{ kind: 'state', texts: ['STOP', '?', ...RUNNING_COMMANDS], required: true }]
  if (state.aspect === 'energized') return [{ kind: 'state', texts: ['DEAD', '?'], required: true }]
  if (state.aspect === 'position' && state.state === undefined) {
    // The model does not compute the position: say so, and what passes.
    return [
      { kind: 'state', texts: ['POS ?'], required: true },
      ...(state.throughput === undefined ? [] : [{ kind: 'throughput' as const, texts: ['PASSING', 'NO FLOW', '?'], required: true as const }]),
      ...(state.command === undefined ? [] : [{ kind: 'mismatch' as const, texts: POSITION_COMMANDS, required: true as const }]),
    ]
  }
  if (state.aspect === 'position') {
    return [
      { kind: 'position', required: true },
      ...(state.command === undefined ? [] : [{ kind: 'mismatch' as const, texts: POSITION_COMMANDS, required: true as const }]),
    ]
  }
  return values
}

/** What a row shows for one sample; empty when there is nothing to say (a fully open valve). */
export const rowText = (row: MimicRow, look: ItemLook, index: SampleIndex, format: (value: number, unit: string) => string): string => {
  if (row.kind === 'marker') {
    if (look.mismatch !== null) return look.mismatch
    if (look.state.kind === 'unknown' || look.notMeasured) return 'POS ?'
    if (look.state.kind !== 'position') return ''
    const fraction = look.state.fraction
    return fraction >= SHUT_BELOW && fraction <= OPEN_ABOVE ? `${Math.round(fraction * 100)} %` : ''
  }
  if (row.kind === 'count') {
    const looks = row.members.map(member => itemLook(member, index))
    const counted = looks.filter(member => counts(member, row.word)).length
    const unknown = looks.some(member => member.state.kind === 'unknown')
    return `${counted}/${row.members.length} ${row.word}${unknown ? ' ?' : ''}`
  }
  if (row.kind === 'value') {
    const entry = index.get(row.path)
    return entry !== undefined && typeof entry.value === 'number' && entry.quality !== 'outside-hard-range' ? format(entry.value, row.unit) : '—'
  }
  if (row.kind === 'position') {
    if (look.state.kind === 'unknown') return 'POS ?'
    if (look.state.kind !== 'position') return ''
    const fraction = look.state.fraction
    return fraction >= 0.05 && fraction <= 0.95 ? format(fraction, 'fraction') : ''
  }
  if (row.kind === 'mismatch') return look.mismatch ?? ''
  if (row.kind === 'throughput') return look.state.kind === 'passing' ? 'PASSING' : look.state.kind === 'notPassing' ? 'NO FLOW' : '?'
  if (row.texts.includes('POS ?')) return 'POS ?'
  // The state word, unless the command row already says the symbol disagrees.
  if (look.mismatch !== null && row.texts.includes(look.mismatch)) return look.mismatch
  return look.state.kind === 'stopped' ? 'STOP' : look.state.kind === 'dead' ? 'DEAD' : look.state.kind === 'unknown' ? '?' : ''
}

/** Whether a member's look is in the state its group counts by. */
const counts = (look: ItemLook, word: string): boolean =>
  word === 'RUN' ? look.state.kind === 'running' : word === 'LIVE' ? look.state.kind === 'energized' : look.state.kind === 'position' && look.state.fraction >= SHUT_BELOW

/**
 * How a drawn item looks for one sample: its own look, or for a group the
 * look of its members together. A group shows its state while any member is
 * in it (one of two feed pumps running still feeds), is unknown when no member
 * is in it and any is unknown, and carries the first command a member does not
 * follow; its count row says how many.
 */
export const drawnLook = (binding: MimicItemBinding, rows: ReadonlyArray<MimicRow>, index: SampleIndex): ItemLook => {
  const count = rows.find((row): row is Extract<MimicRow, { kind: 'count' }> => row.kind === 'count')
  if (count === undefined) return itemLook(binding, index)
  const looks = count.members.map(member => itemLook(member, index))
  const counted = looks.filter(look => counts(look, count.word))
  const mismatch = looks.find(look => look.mismatch !== null)?.mismatch ?? null
  const words = `${counted.length} of ${looks.length} ${count.word === 'RUN' ? 'running' : count.word === 'LIVE' ? 'energized' : 'open'}${mismatch === null ? '' : `; a member is ${mismatch.replace('CMD', 'commanded').toLowerCase()}`}`
  const state = counted[0]?.state ?? (looks.some(look => look.state.kind === 'unknown') ? { kind: 'unknown' as const } : looks[0]!.state)
  return { state, notMeasured: looks.some(look => look.notMeasured), mismatch, words }
}

/** A pipe standing for parallel pipes carries flow while any of them does; it is unknown when none does and any is unknown. */
export const bundleFlowLook = (flows: ReadonlyArray<MimicFlowBinding>, index: SampleIndex): FlowLook => {
  const looks = flows.map(flow => flowLook(flow, index))
  const order: ReadonlyArray<FlowLook['look']> = ['forward', 'reverse', 'flowing', 'unknown', 'none']
  return looks.reduce((best, look) => (order.indexOf(look.look) < order.indexOf(best.look) ? look : best))
}

export const itemRowTexts = (binding: MimicItemBinding, presentation: MimicPresentation, rows: ReadonlyArray<MimicRow>, index: SampleIndex, format: (value: number, unit: string) => string): ReadonlyArray<string> => {
  const look = drawnLook(binding, rows, index)
  return rows.map(row => rowText(row, look, index, format))
}
