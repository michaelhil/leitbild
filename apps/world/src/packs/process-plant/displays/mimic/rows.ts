import type { MimicItemBinding } from './bindings.ts'
import { itemLook, type ItemLook, type SampleIndex } from './evaluate.ts'
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

const POSITION_COMMANDS = ['CMD SHUT', 'CMD OPEN', 'CMD 100 %', 'CMD 10 %']
const RUNNING_COMMANDS = ['CMD RUN', 'CMD STOP']

export const itemRows = (binding: MimicItemBinding, presentation: MimicPresentation): ReadonlyArray<MimicRow> => {
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

export const itemRowTexts = (binding: MimicItemBinding, presentation: MimicPresentation, index: SampleIndex, format: (value: number, unit: string) => string): ReadonlyArray<string> => {
  const look = itemLook(binding, index)
  return itemRows(binding, presentation).map(row => rowText(row, look, index, format))
}
