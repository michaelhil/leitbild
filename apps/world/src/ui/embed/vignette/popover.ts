import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import type { SimulationRunId } from '../../../core/model/index.ts'
import { defaultDisplayEnvelope, readDefaultDisplay } from '../../process-display/default-display.ts'
import { activeWorkspaceId } from '../../workspace-context.ts'
import { digest, openedListing } from '../opened-display.ts'
import type { DisplayOpening, ViewHost } from '../view-host.ts'

// An element's faceplate (L2, plan v5 §3) an interactive drawing opens on one
// of its items, the overlays a person pins from it, and where they stand. Its
// magnifier, or Shift+Enter on the item, opens the item's faceplate; a second
// press of the magnifier, Esc, a press outside it and its item, focus leaving
// the display or the display being put away closes it. Its pin keeps it on
// the display as an overlay a person drags by its header and resizes by its
// corner, which stays until its pin is pressed again; several may stand at
// once, the one touched last on top. A faceplate stands beside its item, never
// over it, inside the part of the frame the window shows, and reads at 100 %
// whatever the display's zoom.
// The overlays' moves and resizes are OLD's (724ae2ac8, mimic/popover.ts),
// ported with their tests (tests/vignette-faceplate.test.ts).

export type FaceplateState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly item: string }

export type FaceplateEvent =
  /** The magnifier, Shift+Enter on the item, or a request to show the element (selection.ts). */
  | { readonly kind: 'pressed'; readonly item: string }
  /** Esc, a press outside it and its item, focus leaving the display, the display put away. */
  | { readonly kind: 'dismissed' }

export const FACEPLATE_CLOSED: FaceplateState = { kind: 'closed' }

/** The next faceplate state: a press opens an item's faceplate, a second press on the same item closes it. */
export const nextFaceplate = (state: FaceplateState, event: FaceplateEvent): FaceplateState => {
  if (event.kind === 'dismissed') return FACEPLATE_CLOSED
  return state.kind === 'open' && state.item === event.item ? FACEPLATE_CLOSED : { kind: 'open', item: event.item }
}

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The room a faceplate keeps from the edges of the room it stands in, in its own px (on screen whatever the zoom). */
export const FACEPLATE_MARGIN = 8

/** A faceplate's width as it opens, and the widths an overlay is resized between: only its readings take the difference. */
export const FACEPLATE_WIDTH = 380
export const OVERLAY_WIDTH = { min: 280, max: 520 } as const
/** A reading's row in a faceplate, in its own px: the rows a resize by height shows or drops. */
export const FACEPLATE_ROW = 24

/**
 * Where a faceplate goes, in the page's px: beside its item where it fits
 * (right, then left), else under or over it, so it never covers the item it
 * is about; shifted inside the room's margins where nothing fits. `room` is
 * the part of the page a person can see (the window shows a tall display
 * scrolled; DisplayPresentation.visible); where it can, it keeps clear of the
 * faceplates pinned there (`avoid`). `scale` is how much the page is
 * magnified on screen: a faceplate is drawn at 1/scale, so it reads at 100 %
 * whatever the zoom, and takes that much more of the page.
 */
export const faceplatePlacement = (item: Box, size: { readonly width: number; readonly height: number }, room: Box, scale: number, avoid: ReadonlyArray<Box> = []): { readonly x: number; readonly y: number } => {
  const width = size.width / scale
  const height = size.height / scale
  const gap = 8 / scale
  const margin = FACEPLATE_MARGIN / scale
  const [left, top, right, bottom] = [room.x + margin, room.y + margin, room.x + room.width - margin, room.y + room.height - margin]
  const clampX = (x: number): number => Math.min(Math.max(left, x), Math.max(left, right - width))
  const clampY = (y: number): number => Math.min(Math.max(top, y), Math.max(top, bottom - height))
  // A place fits where the whole card stands inside the room (an item scrolled out of view has no room beside it).
  const inside = (x: number, y: number): boolean => x >= left && x + width <= right && y >= top && y + height <= bottom
  const candidates = [
    { x: item.x + item.width + gap, y: clampY(item.y) },
    { x: item.x - gap - width, y: clampY(item.y) },
    { x: clampX(item.x), y: item.y + item.height + gap },
    { x: clampX(item.x), y: item.y - gap - height },
  ].map(candidate => ({ ...candidate, fits: inside(candidate.x, candidate.y) }))
  // Where it fits, it also keeps clear of the faceplates already pinned there.
  const clear = (candidate: { readonly x: number; readonly y: number }): boolean => avoid.every(other =>
    candidate.x >= other.x + other.width || candidate.x + width <= other.x || candidate.y >= other.y + other.height || candidate.y + height <= other.y)
  const chosen = candidates.find(candidate => candidate.fits && clear(candidate)) ?? candidates.find(candidate => candidate.fits)
  return chosen === undefined ? { x: clampX(item.x + item.width + gap), y: clampY(item.y) } : { x: chosen.x, y: chosen.y }
}

/** The tallest a faceplate may be, in its own px: the room's height on screen less its margins; what it holds beyond scrolls inside it. */
export const faceplateHeight = (room: Pick<Box, 'height'>, scale: number): number => Math.max(0, room.height * scale - 2 * FACEPLATE_MARGIN)

// --- Pinned overlays (OLD mimic/popover.ts, 724ae2ac8) -------------------------------------------------------------------

/**
 * An element's faceplate pinned on the display, by the drawn item it was
 * opened on. `x`, `y`: where it stands in the page's px. `width`: its own px,
 * drawn at 1/scale. `rows`: how many of its readings it shows once resized
 * by height, the rest dropped from the bottom; null for all of them.
 */
export interface PinnedOverlay {
  readonly item: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly rows: number | null
}

/** Pins an item's faceplate where it stands, or, pinned already, closes its overlay. The overlay pinned last stands on top. */
export const togglePinned = (overlays: ReadonlyArray<PinnedOverlay>, pinned: PinnedOverlay): ReadonlyArray<PinnedOverlay> =>
  overlays.some(overlay => overlay.item === pinned.item) ? overlays.filter(overlay => overlay.item !== pinned.item) : [...overlays, pinned]

/** The overlay a person touched last stands on top of the others. */
export const raisedOverlay = (overlays: ReadonlyArray<PinnedOverlay>, item: string): ReadonlyArray<PinnedOverlay> => {
  const touched = overlays.find(overlay => overlay.item === item)
  return touched === undefined || overlays.at(-1) === touched ? overlays : [...overlays.filter(overlay => overlay !== touched), touched]
}

/**
 * An overlay kept within the room a person sees: moved back inside it where
 * a resize of the window, a scroll or a change of zoom left it partly
 * outside. `drawnHeight` is its whole height as drawn, in its own px.
 */
export const keptInRoom = (overlay: PinnedOverlay, drawnHeight: number, room: Box, scale: number): PinnedOverlay => {
  const x = Math.min(Math.max(room.x, overlay.x), Math.max(room.x, room.x + room.width - overlay.width / scale))
  const y = Math.min(Math.max(room.y, overlay.y), Math.max(room.y, room.y + room.height - drawnHeight / scale))
  return x === overlay.x && y === overlay.y ? overlay : { ...overlay, x, y }
}

/** An overlay dragged by its header from where it stood by the pointer's travel (page px), within the room. */
export const movedOverlay = (from: PinnedOverlay, travel: { readonly dx: number; readonly dy: number }, drawnHeight: number, room: Box, scale: number): PinnedOverlay =>
  keptInRoom({ ...from, x: from.x + travel.dx, y: from.y + travel.dy }, drawnHeight, room, scale)

/**
 * An overlay resized by its corner from the width and rows it had by the
 * pointer's travel (page px; its own px grow by the travel times its scale):
 * its width between OVERLAY_WIDTH and the room's right edge, its rows whole,
 * from one to all `available`, never past the room's bottom edge
 * (`drawnHeight`: its whole height as it began).
 */
export const resizedOverlay = (
  from: PinnedOverlay,
  start: { readonly width: number; readonly rows: number },
  travel: { readonly dx: number; readonly dy: number },
  available: number,
  drawnHeight: number,
  room: Box,
  scale: number,
): PinnedOverlay => {
  const widest = Math.max(OVERLAY_WIDTH.min, Math.min(OVERLAY_WIDTH.max, (room.x + room.width - from.x) * scale))
  const width = Math.round(Math.min(widest, Math.max(OVERLAY_WIDTH.min, start.width + travel.dx * scale)))
  const below = (room.y + room.height - from.y) * scale - (drawnHeight - start.rows * FACEPLATE_ROW)
  const tallest = Math.max(1, Math.min(available, Math.floor(below / FACEPLATE_ROW)))
  const rows = Math.min(tallest, Math.max(1, Math.round(start.rows + (travel.dy * scale) / FACEPLATE_ROW)))
  return { ...from, width, rows: rows >= available ? null : rows }
}

/**
 * The overlays after the room changed (the window narrowed, the chat opened):
 * each one that no longer stands wholly inside it goes beside its item again
 * (faceplatePlacement, never over it, clear of the others where it can be),
 * and is only pushed inside where its item is gone; one that still fits stays
 * where the person put it.
 */
export const replacedOverlays = (
  overlays: ReadonlyArray<PinnedOverlay>,
  sized: (overlay: PinnedOverlay) => { readonly item: Box | null; readonly height: number },
  room: Box,
  scale: number,
): ReadonlyArray<PinnedOverlay> => {
  let changed = false
  const next = overlays.map(overlay => ({ overlay, height: sized(overlay).height }))
  const boxOf = (entry: { readonly overlay: PinnedOverlay; readonly height: number }): Box => ({ x: entry.overlay.x, y: entry.overlay.y, width: entry.overlay.width / scale, height: entry.height / scale })
  next.forEach((entry, at) => {
    const { overlay, height } = entry
    const inside = overlay.x >= room.x && overlay.y >= room.y && overlay.x + overlay.width / scale <= room.x + room.width && overlay.y + height / scale <= room.y + room.height
    if (inside) return
    changed = true
    const item = sized(overlay).item
    // Beside its item, clear of the other overlays where it can be.
    const others = next.filter((_, other) => other !== at).map(boxOf)
    next[at] = { overlay: item === null ? keptInRoom(overlay, height, room, scale) : { ...overlay, ...faceplatePlacement(item, { width: overlay.width, height }, room, scale, others) }, height }
  })
  return changed ? next.map(entry => entry.overlay) : overlays
}

/** Pins live with their display for the browser session, by the display's key (its state's digest) and the item each was opened on. */
export const pinsKey = (displayKey: string): string => `leitbild.faceplates:${digest(displayKey)}`

const pinSchema = (value: unknown): value is PinnedOverlay => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.item === 'string' && [entry.x, entry.y, entry.width].every(number => typeof number === 'number' && Number.isFinite(number))
    && (entry.rows === null || (typeof entry.rows === 'number' && Number.isInteger(entry.rows) && entry.rows >= 1))
}

/** A display's pins as this browser session kept them; a stored value that is not a list of pins is refused aloud. */
export const readPins = (storage: Pick<Storage, 'getItem'>, displayKey: string): ReadonlyArray<PinnedOverlay> => {
  const text = storage.getItem(pinsKey(displayKey))
  if (text === null) return []
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed) || !parsed.every(pinSchema)) throw new Error(`The pinned faceplates of this display cannot be read: ${text.slice(0, 120)}`)
  return parsed.map(({ item, x, y, width, rows }) => ({ item, x, y, width, rows }))
}

export const writePins = (storage: Pick<Storage, 'setItem' | 'removeItem'>, displayKey: string, overlays: ReadonlyArray<PinnedOverlay>): void => {
  if (overlays.length === 0) storage.removeItem(pinsKey(displayKey))
  else storage.setItem(pinsKey(displayKey), JSON.stringify(overlays))
}

/** A drag, a key step or a resize of a pinned overlay, as its card reports it. */
export type OverlayChange =
  | { readonly kind: 'move'; readonly travel: { readonly dx: number; readonly dy: number }; readonly end: boolean }
  | { readonly kind: 'resize'; readonly travel: { readonly dx: number; readonly dy: number }; readonly end: boolean; readonly available: number }

// --- What a faceplate offers ----------------------------------------------------------------------------------------------

/**
 * What an element's faceplate offers by where its display is shown
 * (view-host.ts): its Pack's actions (its proposal and controls) only in the
 * display window; framed by a page that opens displays for it (a chat
 * answer's, which relays to the Workspace's window, or a procedure tag
 * dialog's), the way there; in a frame no page hosts, nothing to act on.
 */
export type ElementOffer = 'actions' | 'open-in-window' | 'nothing'
export const elementOffer = (opening: DisplayOpening | null): ElementOffer =>
  opening === 'window' ? 'actions' : opening === 'relay' ? 'open-in-window' : 'nothing'

/** The display an element's faceplate opened from, as the listing of the element's default names it (opened-display.ts). */
export interface OpenedFrom {
  /** Stable for that display: the element's default opened from it keeps one key. */
  readonly key: string
  readonly title: string
}

/**
 * Opens the element's default (`envelope`, World's default display of the
 * element) in the Workspace's display window, through the page that frames
 * the display (view-host.ts openDisplay), captioned with the display it was
 * opened from. False where nothing opens it.
 */
export const openElementDefault = (host: Pick<ViewHost, 'openDisplay'>, from: OpenedFrom, envelope: EmbeddedViewEnvelope): boolean =>
  host.openDisplay({ state: envelope.state, title: envelope.title, listing: () => openedListing({ ...from, envelope }, { state: envelope.state, title: envelope.title }) })

/**
 * An element's detail (L3): World composes its default (`<objectId>#<elementId>`) and the display it is opened from
 * opens it after itself (openElementDefault). False where nothing opens it; a default World refuses throws its words.
 */
export const openElementDetail = async (host: Pick<ViewHost, 'openDisplay'>, runId: SimulationRunId, from: OpenedFrom, objectId: string, elementId: string): Promise<boolean> => {
  const view = await readDefaultDisplay(runId, `${objectId}#${elementId}`)
  return openElementDefault(host, from, defaultDisplayEnvelope({ workspaceId: activeWorkspaceId(), simulationRunId: runId, view }))
}
