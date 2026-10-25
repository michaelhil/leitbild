/** Event ownership comes from the actual composed DOM path, including shadow hosts. */
export const physicalExplorerKeyboardRoute = (input: {
  readonly path: ReadonlyArray<unknown>
  readonly surface: unknown
  readonly overlay: unknown | null
  readonly defaultPrevented: boolean
  readonly composing: boolean
  readonly descendantOwnsKeys: boolean
}): 'surface' | 'overlay' | null => {
  if (input.defaultPrevented || input.composing || input.descendantOwnsKeys) return null
  if (input.path.includes(input.surface)) return 'surface'
  return input.overlay !== null && input.path.includes(input.overlay) ? 'overlay' : null
}

/** Inspection acquisition remains independent of whether the visual status layer is shown. */
export const physicalExplorerNeedsLive = (input: {
  readonly active: boolean
  readonly documentVisible: boolean
  readonly suspended: boolean
  readonly ready: boolean
  readonly statusLayer: boolean
  readonly sceneId: string
  readonly inspectedSceneId: string | null
}): boolean => input.active && input.documentVisible && !input.suspended && input.ready
  && (input.statusLayer || input.inspectedSceneId === input.sceneId)

/** The same operational capture boundary applies to both physical viewport hosts. */
export const physicalExplorerOperationalCapture = (input: {
  readonly placement: boolean
  readonly assignment: boolean
  readonly targetPicking: boolean
  readonly controllerSelected: boolean
}): boolean => input.placement || input.assignment || input.targetPicking || input.controllerSelected
