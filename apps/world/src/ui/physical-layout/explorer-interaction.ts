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

/**
 * The layout toolbar's status line, and whether it has nothing to report.
 * Quiet is a whitelist: only the all-ready collection text and the focused
 * steady text, each without a hint and without Retry, leave the map uncovered.
 * Every other text is shown, as is any text added here without `steady`.
 */
export const physicalExplorerStatusLine = (input: {
  /** Each layout's representation while a collection is shown; null while one layout is focused. */
  readonly collection: ReadonlyArray<PhysicalScenePresentation['status']> | null
  /** The focused layout; in a collection it stands for the shared view settings. */
  readonly focused: Pick<PhysicalScenePresentation, 'status' | 'reason' | 'view'> | null
  /** The focused layout's live acquisition. */
  readonly live: {
    readonly phase: 'connecting' | 'live' | 'inactive' | 'missing' | 'failed' | 'suspended'
    readonly failure: string | null
    readonly stamp: { readonly receivedWallMs: number } | null
    readonly latest: { readonly sample: { readonly at: { readonly paused: boolean } }; readonly subjects: ReadonlyArray<unknown> } | null
  } | null
  readonly frozen: boolean
  readonly wallNowMs: number
  readonly ownerAlerts: number
  /** Additional layers still preparing or unavailable; empty when none. */
  readonly layerPreparation: string
  /** Floors the focused scope offers. */
  readonly floors: number
  readonly suspended: boolean
  readonly retry: boolean
}): { readonly text: string; readonly quiet: boolean } => {
  const { collection, focused, live } = input
  const shown = (text: string) => ({ text, steady: false }), steady = (text: string) => ({ text, steady: true })
  const count = (status: PhysicalScenePresentation['status']): number => collection?.filter(value => value === status).length ?? 0
  const base = collection !== null ? { text: `${count('ready')} layouts ready · ${count('loading')} loading · ${count('unavailable')} unavailable · owner-qualified alarms remain in Run`, steady: collection.length > 0 && count('ready') === collection.length }
    : focused?.status === 'loading' ? shown('Loading this physical layout…')
    : focused?.status === 'distant' ? shown('Explore on map to load this physical layout')
    : focused?.status === 'hidden' ? shown('Physical detail hidden by view settings')
    : focused?.status === 'unavailable' ? shown(focused.reason ?? 'Layout unavailable')
    : live !== null && live.failure !== null ? shown(live.failure)
    : live?.phase === 'inactive' ? shown('Run not loaded; layout is not live')
    : live?.phase === 'missing' ? shown('Run missing')
    : live === null || live.latest === null ? shown('Waiting for live owner status')
    : input.frozen ? shown(`Not live · ${live.phase === 'suspended' ? 'updates suspended' : live.phase} · last acquired ${Math.max(0, Math.floor((input.wallNowMs - (live.stamp?.receivedWallMs ?? input.wallNowMs)) / 1000))} s ago`)
    : steady(`${live.latest.sample.at.paused ? 'Paused · fresh' : 'Live'} · ${live.latest.subjects.length} modelled subjects · ${input.ownerAlerts} owner alerts`)
  const hints = [
    ...(focused !== null && !focused.view.live ? ['Status layer off'] : []),
    ...(focused?.view.mode === '3d' && focused.view.levelId === 'all' && input.floors > 0 ? ['Choose a floor to inspect the interior.'] : []),
  ]
  const status = input.suspended ? 'Inspection suspended while choosing an operational target.' : [base.text, input.layerPreparation].filter(Boolean).join(' · ')
  return { text: [status, ...hints].join(' · '), quiet: base.steady && !input.suspended && !input.retry && input.layerPreparation === '' && hints.length === 0 }
}
