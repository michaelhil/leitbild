// A flow drawing's text as it is set (plan v5 W6.5; U-12, U-26, C10): in
// OpenBridge's Noto Sans, the subset of it the embed ships (ui/embed/
// noto-sans-font.ts), at a size and weight for each kind of line: a name at
// 12 px, neutral; a state word and a reading at 14 px, a vessel's reading at
// 16 px, in the active colour; the command an item does not follow at 14 px
// bold. The composer reserves each line's room server-side from Noto Sans's
// own advance widths, measured from the font OpenBridge ships at its regular
// and bold weights (text-width.test.ts holds them to it): a name or a stop's
// label, at its width; a word at its longest declared word; a reading's
// value, read later, at so many figures (Noto Sans sets them tabular).
// Nothing is measured in the browser.

/** The kinds of line a drawn item writes, each in its own size and weight. */
export type FlowTextStyle = 'name' | 'word' | 'command' | 'reading' | 'vesselReading'

/** Size, line height in px and weight of each kind of line; a name is reserved at its bold width, which it takes while an alert stands on its item. */
export const FLOW_TEXT: Readonly<Record<FlowTextStyle, { readonly size: number; readonly line: number; readonly weight: 400 | 700 }>> = {
  name: { size: 12, line: 16, weight: 400 },
  word: { size: 14, line: 16, weight: 400 },
  command: { size: 14, line: 16, weight: 700 },
  reading: { size: 14, line: 16, weight: 400 },
  vesselReading: { size: 16, line: 20, weight: 400 },
}

/** Every character the table measures, and the subset of Noto Sans the embed ships: printable ASCII and the signs readings write. */
export const FLOW_TEXT_CHARACTERS = ` !"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_\`abcdefghijklmnopqrstuvwxyz{|}~×⁻⁰¹²³⁴⁵⁶⁷⁸⁹°·µ−–—…`

/**
 * A reading a drawing traces with its item (W6.6): the registered sparkline (ui/embed/vignette/Sparkline.svelte) of its
 * last ten minutes, as a values row draws it, on a line of its own under the item's readings; an exchanger draws it in
 * its tile instead.
 */
export const FLOW_TRACE = { width: 56, height: 20, line: 24 } as const

/** Between an item's symbol and its text: OpenBridge's alert frame reaches the edge of the symbol's box, and its text keeps clear of it (U-14). */
export const TEXT_INSET = 4

/** Noto Sans advance widths in font units (1000 an em) at wght 400 and 700, in FLOW_TEXT_CHARACTERS's order. */
const ADVANCES: Readonly<Record<400 | 700, ReadonlyArray<number>>> = {
  400: [
    260, 269, 408, 646, 572, 831, 732, 225, 300, 300, 551, 572, 268, 322, 268, 372, 572, 572, 572, 572, 572, 572, 572, 572,
    572, 572, 268, 268, 572, 572, 572, 434, 899, 639, 650, 632, 730, 556, 519, 728, 741, 339, 273, 619, 524, 907, 760, 781,
    605, 781, 622, 549, 556, 731, 600, 930, 586, 566, 572, 329, 372, 329, 572, 444, 281, 561, 615, 480, 615, 564, 344, 615,
    618, 258, 258, 534, 258, 935, 618, 605, 615, 615, 413, 479, 361, 618, 508, 786, 529, 510, 470, 380, 551, 380, 572, 572,
    338, 350, 350, 350, 350, 350, 350, 350, 350, 350, 350, 428, 268, 623, 322, 500, 1000, 791,
  ],
  700: [
    260, 286, 472, 646, 572, 901, 750, 266, 339, 339, 545, 572, 285, 322, 285, 413, 572, 572, 572, 572, 572, 572, 572, 572,
    572, 572, 285, 285, 572, 572, 572, 477, 897, 690, 672, 637, 740, 560, 549, 724, 765, 389, 331, 664, 565, 943, 813, 796,
    628, 796, 660, 551, 579, 756, 650, 967, 667, 624, 579, 331, 413, 331, 572, 411, 362, 604, 633, 514, 633, 591, 387, 633,
    657, 305, 305, 620, 305, 982, 657, 619, 633, 633, 454, 497, 434, 657, 569, 856, 578, 569, 488, 394, 551, 394, 572, 572,
    359, 379, 379, 379, 379, 379, 379, 379, 379, 379, 379, 428, 285, 660, 322, 500, 1000, 855,
  ],
}
const UNITS_PER_EM = 1000
/** A character the subset does not carry is set in a fallback face: reserved a whole em, wider than any it measures. */
const UNMEASURED = UNITS_PER_EM
const index = new Map([...FLOW_TEXT_CHARACTERS].map((character, at) => [character, at]))

/** A line's width in px as Noto Sans sets it in `style` (kerning aside: within 1.5 % of the shaped width), rounded up. */
export const textWidth = (text: string, style: FlowTextStyle): number => {
  const { size, weight } = FLOW_TEXT[style]
  // A name is reserved bold: an alert on its item sets it so.
  const advances = ADVANCES[style === 'name' ? 700 : weight]
  const units = [...text].reduce((sum, character) => sum + (index.has(character) ? advances[index.get(character)!]! : UNMEASURED), 0)
  return Math.ceil((units * size) / UNITS_PER_EM)
}

/** Noto Sans's figure, in font units: it sets its figures tabular, each as wide. */
const FIGURE = 572

/** The room of `figures` in `style`: a value read when the drawing is drawn, reserved at so many figures. */
export const textFigures = (figures: number, style: FlowTextStyle): number => Math.ceil((figures * FIGURE * FLOW_TEXT[style].size) / UNITS_PER_EM)
