import { drawingScale, type VignetteView } from '../../../features/displays/compose/model.ts'

// One vignette row in px: the OpenBridge grid. The composer counts rows; the display Capability sizes a frame from them.
export const VIGNETTE_ROW_PX = 24

/** Whether a view's sections stand beside its drawing: a window frame's view (`beside`) that draws one. */
export const standsBeside = (view: { readonly beside?: true; readonly sections: ReadonlyArray<{ readonly kind: string }> }): boolean =>
  view.beside === true && view.sections.some(section => section.kind === 'topology')

/** A window frame's column beside its drawing, and the gap between them, in px. */
export const COLUMN_PX = 360
export const BESIDE_GAP_PX = 16
export const VIGNETTE_INSET_PX = 8

/** A flow overview's useful canvas, including its value/alert column. Its header
 * and footer share this width rather than spreading across W/zoom empty space.
 * The window scales and scrolls this complete canvas; chat and network views
 * keep frameLayout's responsive band/fit behavior. */
export const flowFrameWidth = (view: VignetteView, zoom: number): number | null => {
  if (!standsBeside(view)) return null
  const topology = view.sections.find(section => section.kind === 'topology')
  if (topology?.kind !== 'topology' || topology.family !== 'flow') return null
  // clientWidth is integer-valued; round the envelope outward so a fractional
  // drawing width cannot spuriously push a complete canvas into the band.
  return Math.ceil(topology.layout.width * VIGNETTE_ROW_PX * drawnScale(topology, zoom) + BESIDE_GAP_PX + COLUMN_PX + 2 * VIGNETTE_INSET_PX)
}
/** A flow drawing's text, and the smallest it is ever scaled to on screen (the window's Fit floor, display-zoom.ts; the composer's DRAWING_SCALE_FLOOR). */
export const DRAWING_TEXT_PX = 12
export const TEXT_FLOOR_PX = 11

/**
 * The scale a drawing stands at in its frame at the window's `zoom`: the scale its rows show it at (drawingScale),
 * raised where the window's zoom would take its 12 px text below TEXT_FLOOR_PX on screen, never past its own size.
 * Taller than its rows there, it scrolls down within them.
 */
export const drawnScale = (section: Parameters<typeof drawingScale>[0], zoom: number): number =>
  Math.max(drawingScale(section), Math.min(1, TEXT_FLOOR_PX / (DRAWING_TEXT_PX * zoom)))

/**
 * How a window frame lays out a drawing and its column (plan v5 W4.3; UX audit U-02, F31): side by side where both
 * fit its width; else the column first, as a band over the drawing. The drawing then stands at its own size where it
 * fits, scaled to the width where its whole fits with its text at TEXT_FLOOR_PX or more on screen (`zoom`: the
 * window's; `drawn`: the scale it stands at, drawnScale, `drawingWidth` already at it), and otherwise scrolls
 * sideways: never both scaled and scrolled. A drawing that scales itself to the width it is given (`toRoom`: a network
 * drawing, network.ts widthFit) stands beside its column wherever it fits the room left there at that floor.
 */
export type FrameLayout =
  | { readonly kind: 'beside' }
  | { readonly kind: 'band'; readonly drawing: 'whole' | 'scrolled' }
  | { readonly kind: 'band'; readonly drawing: 'scaled'; readonly scale: number }

export const frameLayout = (frame: { readonly width: number; readonly drawingWidth: number; readonly drawn: number; readonly zoom: number; readonly toRoom?: true }): FrameLayout => {
  const { width, drawingWidth, drawn, zoom } = frame
  /** Whether the drawing scaled by `scale` keeps its text at TEXT_FLOOR_PX or more on screen. */
  const readable = (scale: number): boolean => DRAWING_TEXT_PX * zoom * drawn * scale >= TEXT_FLOOR_PX
  const room = width - BESIDE_GAP_PX - COLUMN_PX
  if (width <= 0 || room >= drawingWidth || (frame.toRoom === true && room > 0 && readable(room / drawingWidth))) return { kind: 'beside' }
  if (width >= drawingWidth) return { kind: 'band', drawing: 'whole' }
  const scale = width / drawingWidth
  return readable(scale) ? { kind: 'band', drawing: 'scaled', scale } : { kind: 'band', drawing: 'scrolled' }
}

/**
 * Whether a view shows alerts only (a Run's or an object's alerts, the full alerts view, an answer's alerts vignette):
 * in a display window its list fills the window's height, never fewer rows than the composer gave it (W2.5).
 */
export const fillsWindow = (view: { readonly sections: ReadonlyArray<{ readonly kind: string }> }): boolean =>
  view.sections.length > 0 && view.sections.every(section => section.kind === 'alerts')
