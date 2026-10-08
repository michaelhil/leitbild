import type { ComposedDisplaySignalRole } from '../../../packs/process-plant/displays/composition.ts'

// Pens are told apart by weight and dash, not hue: colour stays reserved for
// alarm states (ISA-101). The role decides emphasis; the index separates two
// pens of the same role.
const dashes = ['', '6 3', '2 3'] as const

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

/** Tags identify instruments; untagged model signals show their label and owner. */
export const displayName = (pen: { readonly tagId?: string; readonly label: string; readonly path: string }): string =>
  pen.tagId ?? `${pen.label} (${String(pen.path).split('.')[0]})`
