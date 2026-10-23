// Where an item's magnifier stands (plan v5 §3, option A): OpenBridge's 16 px
// search glyph straight after the item's name, in the first line of its text,
// with a 40 px hit area round it. The composer keeps no cell for it: the glyph
// sits in the room the line leaves, never closer than 4 px to the drawing's
// right edge, and its hit area stays inside the drawing so it never widens
// what scrolls. The item's own ink (its symbol and its text) stands above the
// hit area, so a press on the item opens its detail and a press on the room
// round the glyph its faceplate.

/** The glyph, its gap after the name, and the square a press finds it in. */
export const MAGNIFIER = { glyph: 16, gap: 4, hit: 40, edge: 4 } as const

export interface MagnifierPlace {
  /** The glyph's top left, in drawing px. */
  readonly glyph: { readonly x: number; readonly y: number }
  /** The hit area's top left; MAGNIFIER.hit square. */
  readonly hit: { readonly x: number; readonly y: number }
  /** Whether the glyph fits the room the layout kept for the line. */
  readonly fits: boolean
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(low, value), Math.max(low, high))

/**
 * The magnifier of an item whose text block starts at `text` (drawing px), whose first line is `line` px tall and
 * whose name is `name` px wide as drawn, in a drawing `drawing` px wide and high.
 */
export const magnifierAt = (
  text: { readonly x: number; readonly y: number; readonly width: number },
  line: number,
  name: number,
  drawing: { readonly width: number; readonly height: number },
): MagnifierPlace => {
  const x = Math.min(text.x + name + MAGNIFIER.gap, drawing.width - MAGNIFIER.edge - MAGNIFIER.glyph)
  const y = text.y + (line - MAGNIFIER.glyph) / 2
  const centre = { x: x + MAGNIFIER.glyph / 2, y: y + MAGNIFIER.glyph / 2 }
  return {
    glyph: { x, y },
    hit: { x: clamp(centre.x - MAGNIFIER.hit / 2, 0, drawing.width - MAGNIFIER.hit), y: clamp(centre.y - MAGNIFIER.hit / 2, 0, drawing.height - MAGNIFIER.hit) },
    fits: name + MAGNIFIER.gap + MAGNIFIER.glyph <= text.width,
  }
}
