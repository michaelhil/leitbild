import type { ComposedDisplaySignalRole } from '../../../packs/process-plant/displays/composition.ts'

// Pens are told apart by weight and dash, not hue: colour stays reserved for
// alarm states (ISA-101). The role decides emphasis; the index separates two
// pens of the same role.
const dashes = ['', '6 3', '2 3', '8 3 2 3'] as const

export const penStroke = (role: ComposedDisplaySignalRole, index: number): string => {
  const width = role === 'primary' ? 2.25 : 1.5
  const color = role === 'context' ? 'var(--element-neutral-color)' : 'var(--element-active-color)'
  const dash = role === 'counter-evidence' ? '4 3' : dashes[index % dashes.length]
  return `stroke: ${color}; stroke-width: ${width}px;${dash === '' ? '' : ` stroke-dasharray: ${dash};`}`
}

export const roleLabel: Readonly<Record<ComposedDisplaySignalRole, string>> = {
  primary: 'primary',
  context: 'context',
  'counter-evidence': 'cross-check',
}

/** What operators call the signal, decided by World: its tag, or its label with its equipment. */
export const displayName = (pen: { readonly name: string }): string => pen.name

/**
 * A name fitted to the room it is shown in by dropping whole words, so no word
 * that carries meaning (deficit, net, margin) is ever cut through: whole;
 * then the equipment's leading words, keeping what tells parallel equipment
 * apart ("Narrow range level · …Generator A", "… · …A"); then the quantity's
 * middle words, keeping its first and last ("Core … deficit · …Core"). The
 * shortest form is returned when none fits; the tooltip keeps the whole name.
 */
export const fitName = (name: string, fits: (text: string) => boolean): string => {
  if (fits(name)) return name
  const at = name.lastIndexOf(' · ')
  const quantity = at < 0 ? name : name.slice(0, at)
  const equipment = at < 0 ? [] : name.slice(at + 3).split(' ')
  const words = quantity.split(' ')
  const withEquipment = (text: string, kept: number): string => kept === 0 ? text : `${text} · ${kept === equipment.length ? '' : '…'}${equipment.slice(-kept).join(' ')}`
  const candidates = [
    ...equipment.slice(1).map((_, index) => withEquipment(quantity, equipment.length - 1 - index)),
    ...words.slice(2).map((_, index) => withEquipment(`${words[0]} … ${words.slice(index + 2 - words.length).join(' ')}`, Math.min(1, equipment.length))),
  ]
  if (candidates.length === 0) return name
  return candidates.find(fits) ?? candidates[candidates.length - 1]!
}
