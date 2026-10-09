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
 * A name shortened from the middle, so the equipment at its end survives:
 * "Process valve position · Feedwater Control Valve B" → "Process valve… Control Valve B".
 */
export const shortName = (name: string, maxLength: number): string => {
  if (name.length <= maxLength) return name
  const tail = Math.ceil((maxLength - 1) * 0.55)
  return `${name.slice(0, maxLength - 1 - tail).trimEnd()}…${name.slice(name.length - tail).trimStart()}`
}
