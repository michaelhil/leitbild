import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { getContext, setContext } from 'svelte'
import type { ObjectId, SimulationRunId } from '../../../core/model/index.ts'
import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
import type { VignetteState } from '../../../features/displays/compose/model.ts'
import { defaultDisplayEnvelope, readDefaultDisplay } from '../../process-display/default-display.ts'
import { VIGNETTE_VIEW_TYPE } from '../../process-display/display-window-messages.ts'
import { invokeSimulationRunCapability } from '../../simulation-run-client.ts'
import { activeWorkspaceId } from '../../workspace-context.ts'
import { openedListing } from '../opened-display.ts'
import { embeddedDisplayFrame, type DisplayOpening } from '../view-host.ts'
import { openElementDefault } from './popover.ts'
import { requestElement } from './selection.ts'

// What a vignette's alerts, trip line, worst chip, entity rows and drawings
// open (plan v5 W2.4–W2.7, W9.1, W9.2): an element, which a drawing of this
// vignette selects where it draws it (selection.ts) and which otherwise opens
// as its default after this display, as an element's pop-over opens it in the
// display window; any other subject's default (an object, an observable)
// after this display; and the full alerts view (L4) of some objects, after
// this display, with Back. All open through the page that frames the
// vignette (view-host.ts): nowhere where none does, so what would open
// nothing is no button there. In the display window, and only there, a
// person acknowledges alerts through their Packs' commands, as the screen's
// own actor. The window may ask it to select an element once (W2.8), which
// its drawing does once drawn.

export interface VignetteOpening {
  /** Where this vignette opens a display: its window, the Workspace's window through the page framing it, or nowhere. */
  readonly where: DisplayOpening | null
  /** The Run time of the latest sample (ms), NaN before one. */
  readonly now: number
  /** Shows the element (selects it where drawn, or opens its detail); resolves to why it cannot be opened, or null once it is shown. */
  readonly element: (objectId: string, elementId: string, how?: 'select' | 'detail') => Promise<string | null>
  /** Opens a subject's default after this display (an object id, or an observable's ref); resolves as `element` does. */
  readonly subject: (subject: string) => Promise<string | null>
  /** Opens the full alerts view of these objects (or the Run's) after this display. */
  readonly alerts: (objectIds: ReadonlyArray<string> | 'run', title: string) => boolean
  /** Opens this display itself in the window: a drawing too small to read in a chat (W7.3). */
  readonly self: () => boolean
  /** Whether a person acknowledges alerts here: in the display window only (D-B1, Q19), never in a chat answer or a dialog. */
  readonly acknowledges: boolean
  /** Acknowledges these alerts as the person, each through its Pack's command (AlertRow.acknowledge); resolves to why one was not, or null. */
  readonly acknowledge: (rows: ReadonlyArray<AlertRow>) => Promise<string | null>
  /** The alert rows this vignette's trip line shows (W2.4), by key: a list short of room leaves them to it (list.ts fitLines). */
  readonly carried: ReadonlySet<string>
  /** The trip line says what it shows, read live while it stands; returns its stop. */
  readonly carry: (shown: () => ReadonlySet<string>) => () => void
}

const NONE: ReadonlySet<string> = new Set()

const KEY = Symbol('vignette-opening')

/**
 * The full alerts view's composed rows: its counts, a row of tiles and a few alerts. The display window gives an
 * alerts-only view its whole height (Vignette.svelte's fill) and its list scrolls in it, so it fits the window at any
 * height instead of standing taller than it and being zoomed out.
 */
const ALERTS_VIEW_ROWS = 12

/** How long a display the window opened to select an element waits for its drawing to show it. */
const SELECT_WAIT_MS = 15_000

/** The opening of the vignette that calls it, for its parts to read (vignetteOpening); call while it is set up. Returns it and its stop. */
export const provideOpening = (config: {
  readonly runId: () => SimulationRunId
  readonly envelope: () => EmbeddedViewEnvelope
  /** The latest sample's time, undefined before one. */
  readonly at: () => { readonly at: string; readonly clock: 'simulation' | 'wall' } | undefined
}): { readonly opening: VignetteOpening; readonly stop: () => void } => {
  let where = $state<DisplayOpening | null>(null)
  const host = embeddedDisplayFrame()
  const stopOpening = host.subscribeOpening(next => { where = next })
  let carrying = $state.raw<(() => ReadonlySet<string>) | null>(null)
  // The window asks for an element to be selected (an alarm strip's group row, W2.8): asked again until a drawing of
  // this display, drawn once its first sample is in, shows it, for at most SELECT_WAIT_MS.
  let selecting: ReturnType<typeof setInterval> | undefined
  const stopSelect = host.subscribeSelect(select => {
    clearInterval(selecting)
    const until = Date.now() + SELECT_WAIT_MS
    const ask = (): void => { if (requestElement({ ...select, how: 'select' }) || Date.now() > until) clearInterval(selecting) }
    selecting = setInterval(ask, 250)
    ask()
  })
  const stop = (): void => { stopOpening(); stopSelect(); clearInterval(selecting) }
  const from = () => ({ key: config.envelope().state, title: config.envelope().title })
  const openDefault = async (subject: string): Promise<string | null> => {
    if (where === null) return 'no display window can show it from here'
    try {
      const view = await readDefaultDisplay(config.runId(), subject)
      const envelope = defaultDisplayEnvelope({ workspaceId: activeWorkspaceId(), simulationRunId: config.runId(), view })
      return openElementDefault(host, from(), envelope) ? null : 'no display window can show it from here'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const opening: VignetteOpening = {
    get where() { return where },
    get now() { const at = config.at(); return at === undefined ? Number.NaN : Date.parse(at.at) },
    element: async (objectId, elementId, how = 'select') => requestElement({ objectId, elementId, how }) ? null : openDefault(`${objectId}#${elementId}`),
    subject: openDefault,
    get carried() { return carrying?.() ?? NONE },
    carry: shown => {
      carrying = shown
      return () => { if (carrying === shown) carrying = null }
    },
    get acknowledges() { return where === 'window' },
    acknowledge: async rows => {
      if (where !== 'window') return 'alerts are acknowledged in the display window'
      for (const row of rows) {
        if (row.acknowledge === undefined) continue
        try {
          const response = await invokeSimulationRunCapability(config.runId(), { capabilityId: row.acknowledge.capabilityId, input: row.acknowledge.input })
          if (response.kind !== 'command') return `${row.alert.message}: not acknowledged`
          if (!response.result.ok) return `${row.alert.message}: ${response.result.reason}`
        } catch (error) {
          return `${row.alert.message}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      return null
    },
    alerts: (objectIds, title) => {
      const sampled = config.at()
      const at = sampled === undefined ? { at: new Date().toISOString(), clock: 'wall' as const } : { at: sampled.at, clock: sampled.clock }
      const state: VignetteState = { title: title.slice(0, 80), at, views: [{ kind: 'alerts', objectIds: objectIds === 'run' ? 'run' : [...objectIds] as ObjectId[], rows: ALERTS_VIEW_ROWS, all: true }] }
      const text = JSON.stringify(state)
      return host.openDisplay({ state: text, title: state.title, viewType: VIGNETTE_VIEW_TYPE, listing: () => openedListing({ ...from(), envelope: config.envelope() }, { state: text, title: state.title, viewType: VIGNETTE_VIEW_TYPE }) })
    },
    self: () => {
      const { state, title } = config.envelope()
      return host.openDisplay({ state, title, viewType: VIGNETTE_VIEW_TYPE, listing: () => openedListing({ ...from(), envelope: config.envelope() }, { state, title, viewType: VIGNETTE_VIEW_TYPE }) })
    },
  }
  setContext(KEY, opening)
  return { opening, stop }
}

/** The opening its vignette provides; undefined where none does (an element's pop-over). */
export const vignetteOpening = (): VignetteOpening | undefined => getContext<VignetteOpening | undefined>(KEY)
