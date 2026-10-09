import metrics from './openbridge-text-metrics.json'

// Widths of OpenBridge text as its components render it, so the server can
// reserve text boxes without a DOM. The table was measured in the real
// components with OpenBridge's Noto Sans, which the embed loads for mimics;
// it is part of the drawing's identity (MIMIC_LAYOUT_VERSION).

/** The text styles of an OpenBridge device's readout stack and alarm flap. */
export type OpenBridgeTextStyle = 'tag' | 'value' | 'unit' | 'stateRow' | 'alertLabel'

interface StyleTable {
  readonly advance: Readonly<Record<string, number>>
  readonly kern: Readonly<Record<string, number>>
}

const styles = metrics.styles as Readonly<Record<OpenBridgeTextStyle, StyleTable>>

/** Characters the table does not cover; text containing them cannot be measured and is rejected. */
export const unmeasurable = (style: OpenBridgeTextStyle, text: string): ReadonlyArray<string> =>
  [...new Set([...text].filter(character => styles[style].advance[character] === undefined))]

/** Rendered width in px, rounded up; throws for characters the table lacks (check `unmeasurable` first). */
export const textWidth = (style: OpenBridgeTextStyle, text: string): number => {
  const table = styles[style]
  let width = 0
  let previous = ''
  for (const character of text) {
    const advance = table.advance[character]
    if (advance === undefined) throw new Error(`no ${style} advance for "${character}"`)
    width += advance + (table.kern[previous + character] ?? 0)
    previous = character
  }
  return Math.ceil(width)
}

/** OpenBridge device geometry at the regular size, in px. */
export const openBridgeDevice = {
  /** The symbol's touch target, centred on its anchor. */
  symbol: 48,
  /** The readout stack's tag line and each value or state row (regular stacks, and our vessel stacks). */
  tagLine: 16,
  row: 20,
  /** A device's stack uses OpenBridge's `small` readout size: 11.5 px rows, 16 px state rows and 18 px value rows. */
  smallStateRow: 16,
  smallValueRow: 18,
  smallTextScale: 11.5 / 16,
  /** A value row is the readout block plus its unit plus this padding. */
  valueRowPadding: 22,
  /** A state row is its text plus this padding. */
  stateRowPadding: 16,
  /** The bottom alarm flap below the button, and where its label starts. */
  flapHeight: 21,
  flapLabelInset: 28,
  /** Tanks and heat exchangers: the box, and how far the visible body sits inside it. */
  vessel: { width: 48, height: 96, inset: 5 },
} as const

/** Width of a readout block holding up to `digits` digits (and a fraction), as OpenBridge reserves it. */
export const readoutBlockWidth = (integerDigits: number, fractionDigits: number): number =>
  textWidth('value', `${'0'.repeat(integerDigits)}${fractionDigits === 0 ? '' : `.${'0'.repeat(fractionDigits)}`}`)

/** A state row of a small readout stack: the regular row's glyphs at 11.5 px (Noto Sans scales linearly). */
export const smallStateRowWidth = (text: string): number =>
  Math.ceil(textWidth('stateRow', text) * openBridgeDevice.smallTextScale) + openBridgeDevice.stateRowPadding

/** A value row of a small readout stack: up to three digits at 11.5 px, then its unit. */
export const smallValueRowWidth = (unit: string): number =>
  Math.ceil(textWidth('stateRow', '000') * openBridgeDevice.smallTextScale) + (unit === '' ? 0 : textWidth('unit', unit)) + openBridgeDevice.valueRowPadding
