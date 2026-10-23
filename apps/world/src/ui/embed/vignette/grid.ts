// One vignette row in px: the OpenBridge grid. The composer counts rows; the display Capability sizes a frame from them.
export const VIGNETTE_ROW_PX = 24

/** Whether a view's sections stand beside its flow drawing: a window frame's view (`beside`) that draws one. */
export const standsBeside = (view: { readonly beside?: true; readonly sections: ReadonlyArray<{ readonly kind: string; readonly family?: string }> }): boolean =>
  view.beside === true && view.sections.some(section => section.kind === 'topology' && section.family === 'flow')
