import type { PhysicalScenePresentation } from '../map/physical-scene/types.ts'

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

/** A new representation of the same validated source does not replace its live owner scope. */
export const physicalExplorerNeedsLive = (input: {
  readonly active: boolean
  readonly documentVisible: boolean
  readonly suspended: boolean
  readonly sourceLoaded: boolean
  readonly locationValid: boolean
  readonly representation: PhysicalScenePresentation['status']
  readonly statusLayer: boolean
  readonly sceneId: string
  readonly inspectedSceneId: string | null
}): boolean => input.active && input.documentVisible && !input.suspended && input.sourceLoaded && input.locationValid
  && (input.representation === 'ready' || input.representation === 'loading')
  && (input.statusLayer || input.inspectedSceneId === input.sceneId)

/** Physical inspection yields to operational target capture on the native map. */
export const physicalExplorerOperationalCapture = (input: {
  readonly placement: boolean
  readonly assignment: boolean
  readonly targetPicking: boolean
  readonly controllerSelected: boolean
}): boolean => input.placement || input.assignment || input.targetPicking || input.controllerSelected
