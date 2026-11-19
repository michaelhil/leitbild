import type { PhysicalScenePresentation, PhysicalSceneView } from '../map/physical-scene/types.ts'
import type { ViewModeControlInput } from '../map/view-mode-control.ts'

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
  readonly targetPicking: boolean
  readonly controllerSelected: boolean
}): boolean => input.placement || input.targetPicking || input.controllerSelected

/**
 * What the map's 3D switch shows. Every layout shares one representation, so
 * the focused layout's mode stands for all; null means no layout is on the map.
 * The switch waits, and says why, while it could not act.
 */
export const physicalExplorerViewModeInput = (input: {
  readonly mode: PhysicalSceneView['mode'] | null
  readonly suspended: boolean
}): ViewModeControlInput => input.mode === null ? { mode: '2d', disabledReason: 'No physical layout is shown on this map' }
  : { mode: input.mode, disabledReason: input.suspended ? 'Plan and 3D wait while an object is being placed or directed on the map' : null }
