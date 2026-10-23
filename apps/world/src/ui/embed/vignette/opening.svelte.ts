import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { getContext, setContext } from 'svelte'
import type { ObjectId, SimulationRunId } from '../../../core/model/index.ts'
import { FRAME_ROWS, VIGNETTE_MAX_ROWS, type VignetteState } from '../../../features/displays/compose/model.ts'
import { defaultDisplayEnvelope, readDefaultDisplay } from '../../process-display/default-display.ts'
import { activeWorkspaceId } from '../../workspace-context.ts'
import { openedListing } from '../opened-display.ts'
import { embeddedDisplayFrame, type DisplayOpening } from '../view-host.ts'
import { openElementDefault } from './popover.ts'
import { requestElement } from './selection.ts'

// What a vignette's alerts, trip line and worst chip open (plan v5 W2.4–W2.6):
// an element, which a drawing of this vignette selects where it draws it
// (selection.ts) and which otherwise opens as its default after this display,
// as an element's pop-over opens it in the display window; and the full
// alerts view (L4) of some objects, after this display, with Back. Both open
// through the page that frames the vignette (view-host.ts): nowhere where
// none does, so what would open nothing is no button there.

export interface VignetteOpening {
  /** Where this vignette opens a display: its window, the Workspace's window through the page framing it, or nowhere. */
  readonly where: DisplayOpening | null
  /** The Run time of the latest sample (ms), NaN before one. */
  readonly now: number
  /** Shows the element (selects it where drawn, or opens its detail); resolves to why it cannot be opened, or null once it is shown. */
  readonly element: (objectId: string, elementId: string, how?: 'select' | 'detail') => Promise<string | null>
  /** Opens the full alerts view of these objects (or the Run's) after this display. */
  readonly alerts: (objectIds: ReadonlyArray<string> | 'run', title: string) => boolean
  /** Opens this display itself in the window: a drawing too small to read in a chat (W7.3). */
  readonly self: () => boolean
}

const KEY = Symbol('vignette-opening')

/** The opening of the vignette that calls it, for its parts to read (vignetteOpening); call while it is set up. Returns it and its stop. */
export const provideOpening = (config: {
  readonly runId: () => SimulationRunId
  readonly envelope: () => EmbeddedViewEnvelope
  /** The latest sample's time, undefined before one. */
  readonly at: () => { readonly at: string; readonly clock: 'simulation' | 'wall' } | undefined
}): { readonly opening: VignetteOpening; readonly stop: () => void } => {
  let where = $state<DisplayOpening | null>(null)
  const host = embeddedDisplayFrame()
  const stop = host.subscribeOpening(next => { where = next })
  const from = () => ({ key: config.envelope().state, title: config.envelope().title })
  const opening: VignetteOpening = {
    get where() { return where },
    get now() { const at = config.at(); return at === undefined ? Number.NaN : Date.parse(at.at) },
    element: async (objectId, elementId, how = 'select') => {
      if (requestElement({ objectId, elementId, how })) return null
      if (where === null) return 'no display window can show it from here'
      try {
        const view = await readDefaultDisplay(config.runId(), `${objectId}#${elementId}`)
        const envelope = defaultDisplayEnvelope({ workspaceId: activeWorkspaceId(), simulationRunId: config.runId(), view })
        return openElementDefault(host, from(), envelope) ? null : 'no display window can show it from here'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    alerts: (objectIds, title) => {
      const sampled = config.at()
      const at = sampled === undefined ? { at: new Date().toISOString(), clock: 'wall' as const } : { at: sampled.at, clock: sampled.clock }
      const state: VignetteState = { title: title.slice(0, 80), at, views: [{ kind: 'alerts', objectIds: objectIds === 'run' ? 'run' : [...objectIds] as ObjectId[], rows: VIGNETTE_MAX_ROWS - FRAME_ROWS, all: true }] }
      const text = JSON.stringify(state)
      return host.openDisplay({ state: text, title: state.title, listing: () => openedListing({ ...from(), envelope: config.envelope() }, { state: text, title: state.title }) })
    },
    self: () => {
      const { state, title } = config.envelope()
      return host.openDisplay({ state, title, listing: () => openedListing({ ...from(), envelope: config.envelope() }, { state, title }) })
    },
  }
  setContext(KEY, opening)
  return { opening, stop }
}

/** The opening its vignette provides; undefined where none does (an element's pop-over). */
export const vignetteOpening = (): VignetteOpening | undefined => getContext<VignetteOpening | undefined>(KEY)
