// One vignette row in px: the OpenBridge grid. The composer counts rows; the display Capability sizes a frame from them.
export const VIGNETTE_ROW_PX = 24

/** Whether a view's sections stand beside its flow drawing: a window frame's view (`beside`) that draws one. */
export const standsBeside = (view: { readonly beside?: true; readonly sections: ReadonlyArray<{ readonly kind: string; readonly family?: string }> }): boolean =>
  view.beside === true && view.sections.some(section => section.kind === 'topology' && section.family === 'flow')

/** A window frame's column beside its drawing, and the gap between them, in px. */
export const COLUMN_PX = 360
export const BESIDE_GAP_PX = 16
/** A flow drawing's text, and the smallest it is ever scaled to on screen (the window's Fit floor, display-zoom.ts; the composer's DRAWING_SCALE_FLOOR). */
export const DRAWING_TEXT_PX = 12
export const TEXT_FLOOR_PX = 11

/**
 * How a window frame lays out a drawing and its column (plan v5 W4.3; UX audit U-02, F31): side by side where both
 * fit its width; else the column first, as a band over the drawing. The drawing then stands at its own size where it
 * fits, scaled to the width where its whole fits with its text at TEXT_FLOOR_PX or more on screen (`zoom`: the
 * window's; `drawn`: the scale its rows show it at, drawingScale, `drawingWidth` already at it), and otherwise scrolls
 * sideways: never both scaled and scrolled.
 */
export type FrameLayout =
  | { readonly kind: 'beside' }
  | { readonly kind: 'band'; readonly drawing: 'whole' | 'scrolled' }
  | { readonly kind: 'band'; readonly drawing: 'scaled'; readonly scale: number }

export const frameLayout = (frame: { readonly width: number; readonly drawingWidth: number; readonly drawn: number; readonly zoom: number }): FrameLayout => {
  const { width, drawingWidth, drawn, zoom } = frame
  if (width <= 0 || width >= drawingWidth + BESIDE_GAP_PX + COLUMN_PX) return { kind: 'beside' }
  if (width >= drawingWidth) return { kind: 'band', drawing: 'whole' }
  const scale = width / drawingWidth
  return DRAWING_TEXT_PX * zoom * drawn * scale >= TEXT_FLOOR_PX ? { kind: 'band', drawing: 'scaled', scale } : { kind: 'band', drawing: 'scrolled' }
}

/**
 * Whether a view shows alerts only (a Run's or an object's alerts, the full alerts view, an answer's alerts vignette):
 * in a display window its list fills the window's height, never fewer rows than the composer gave it (W2.5).
 */
export const fillsWindow = (view: { readonly sections: ReadonlyArray<{ readonly kind: string }> }): boolean =>
  view.sections.length > 0 && view.sections.every(section => section.kind === 'alerts')
