// How a dashboard stands on its page (plan v5 R4 B4): its run frame, a
// vignette of the whole Run's alerts sampled live (W2's counts, tiles and
// list, its worst chip the Run-wide worst priority), within 30 % of the
// screen's height (T17); its sections, each a vignette the dashboard samples
// only while it can be seen; on a phone the frame and one section (D9).
import { embeddedViewEnvelopeSchema, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import { FRAME_ROWS } from '../../../features/displays/compose/model.ts'
import { VIGNETTE_VIEW_TYPE } from '../../process-display/display-window-messages.ts'
import { digest } from '../opened-display.ts'
import type { DashboardScope, DashboardSection } from './dashboard.ts'

/** Narrower than this, a page is a phone's: the frame and one section (D9). */
export const PHONE_MAX_WIDTH = 768
export const isPhone = (width: number): boolean => width > 0 && width < PHONE_MAX_WIDTH
/**
 * A phone draws the dashboard's parts at this scale: the vignette renderer's smallest type is 10 px (a value's SIM
 * tag), so every word stands at 12 px or more (D9). The test holds it to the renderer's styles.
 */
export const PHONE_SCALE = 1.2

/** The sections a page shows: on a phone the one chosen (clamped to those there are), else all. */
export const sectionsShown = <T>(sections: ReadonlyArray<T>, phone: boolean, chosen: number): ReadonlyArray<T> =>
  !phone ? sections : sections.slice(Math.max(0, Math.min(chosen, sections.length - 1)), Math.max(0, Math.min(chosen, sections.length - 1)) + 1)

/** The share of the screen's height the run frame takes at most (T17), and of its own page's where that is less. */
export const FRAME_SHARE = 0.3
export const FRAME_PAGE_SHARE = 0.5
/** The fewest rows its alerts list gets: its head, a line and "+N more". */
export const FRAME_MIN_ROWS = 3
/** The frame's title: it is the whole Run's on every scope. */
export const FRAME_TITLE = 'Whole Run'

/**
 * The rows the frame's alerts list gets: what 30 % of the screen's height holds at the window's zoom (T17), and no
 * more than half the page's own, less the frame vignette's title and footer.
 */
export const frameAlertRows = (room: { readonly screen: number; readonly page: number; readonly zoom: number }, rowPx: number): number =>
  Math.max(FRAME_MIN_ROWS, Math.floor(Math.min((FRAME_SHARE * room.screen) / room.zoom, FRAME_PAGE_SHARE * room.page) / rowPx) - FRAME_ROWS)

/** The run frame: the whole Run's alerts as a vignette of `rows`, composed now on the wall clock and sampled live. */
export const frameEnvelope = (dashboard: EmbeddedViewEnvelope, rows: number, at: string): EmbeddedViewEnvelope => embeddedViewEnvelopeSchema.parse({
  ...dashboard,
  viewType: VIGNETTE_VIEW_TYPE,
  title: FRAME_TITLE,
  height: dashboard.height,
  state: JSON.stringify({ title: FRAME_TITLE, at: { at, clock: 'wall' }, views: [{ kind: 'alerts', objectIds: 'run', rows }] }),
})

/** A section's vignette on the dashboard's Run. */
export const sectionEnvelope = (dashboard: EmbeddedViewEnvelope, view: NonNullable<DashboardSection['view']>): EmbeddedViewEnvelope =>
  embeddedViewEnvelopeSchema.parse({ ...dashboard, viewType: view.viewType, title: view.title, height: view.height, state: view.state })

/**
 * A section's identity across reads: a pin's id; a default section's title and what it draws, less the time it was
 * composed, so it stays mounted (and sampling) while World's default draws the same.
 */
export const sectionKey = (section: DashboardSection): string => {
  if (section.id !== undefined) return section.id
  if (section.view === undefined) return `refused:${section.title}`
  const { at: _at, ...drawn } = JSON.parse(section.view.state) as Record<string, unknown>
  return `default:${section.title}:${digest(JSON.stringify(drawn))}`
}

/** The object a section leads with (a default section's lead request), whose own dashboard it opens; null for none. */
export const leadObjectOf = (section: DashboardSection): string | null => {
  if (section.view === undefined) return null
  const views = (JSON.parse(section.view.state) as { readonly views?: ReadonlyArray<{ readonly lead?: { readonly objectId?: unknown } }> }).views ?? []
  const objectId = views.find(view => typeof view.lead?.objectId === 'string')?.lead?.objectId
  return typeof objectId === 'string' ? objectId : null
}

/** What World's default of a scope is, in words. */
export const defaultText = (scope: DashboardScope): string =>
  scope === 'run' ? 'World\'s default: each observed asset\'s leads' : 'subject' in scope ? 'World\'s default of this object' : 'World\'s default: its members side by side'

/**
 * Which parts of a dashboard sample: the frame and the sections while the page can be seen (its window shows it), a
 * section only while it is scrolled into view. A part not yet seen in or out of view counts as in view.
 */
export const createBoardVisibility = () => {
  let page = true
  const inView = new Map<string, boolean>()
  const listeners = new Map<string, Set<(visible: boolean) => void>>()
  const shown = (key: string): boolean => page && inView.get(key) !== false
  const tell = (key: string): void => { for (const listener of [...(listeners.get(key) ?? [])]) listener(shown(key)) }
  return {
    setPage: (visible: boolean): void => {
      if (visible === page) return
      page = visible
      for (const key of [...listeners.keys()]) tell(key)
    },
    setInView: (key: string, visible: boolean): void => {
      if (inView.get(key) === visible) return
      inView.set(key, visible)
      tell(key)
    },
    /** A part's visibility, told at once and on every change; returns the stop. */
    subscribe: (key: string) => (listener: (visible: boolean) => void): (() => void) => {
      const set = listeners.get(key) ?? listeners.set(key, new Set()).get(key)!
      set.add(listener)
      listener(shown(key))
      return () => {
        set.delete(listener)
        if (set.size === 0) { listeners.delete(key); inView.delete(key) }
      }
    },
  }
}
