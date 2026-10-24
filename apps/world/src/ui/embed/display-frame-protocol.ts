// Messages between World's process display window and the display frames it
// shows. Both ends are World pages on one origin, so this stays World-internal:
// the window tells a frame whether it is shown, at what zoom and what Back
// returns to; the frame says how much room its content needs, passes on zoom
// gestures made inside it, and asks for a display to be opened after it.
// Each end accepts a message only from the window it expects (the frame's
// parent, or the frame's own contentWindow) on the same origin.
import { DASHBOARD_VIEW_TYPE, VIGNETTE_VIEW_TYPE, type WorldViewType } from '../process-display/display-window-messages.ts'

export const DISPLAY_ZOOM_MIN = 0.5
export const DISPLAY_ZOOM_MAX = 2

/** Window -> frame: the frame's current presentation; sent on its ready message and on every change. */
export interface DisplayFramePresentation {
  readonly type: 'world:display-frame'
  /** A hidden frame stops sampling; shown again it catches up before drawing on. */
  readonly shown: boolean
  /** The scale the window paints the frame at, so canvases can be drawn sharp for it. */
  readonly zoom: number
  /** For a display the window opened from another: the title of that one, which Back returns to. */
  readonly back?: string
  /**
   * The part of the frame a person sees, in the frame's own px: the window scrolls a display taller or wider than
   * its body, and keeps clear of its own resize handles at the body's edges. A faceplate stands inside it.
   */
  readonly visible?: DisplayFrameRoom
}

export interface DisplayFrameRoom {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Frame -> window: listening; the window answers with the presentation. */
export interface DisplayFrameReady {
  readonly type: 'world:display-frame-ready'
}

/**
 * Frame -> window: the room the content needs, in the frame's own CSS pixels.
 * An advice display is fixed in height and stretches in width down to
 * `minWidth`; a generated display (overview, detail) is drawn for the frame and
 * needs `width` x `height` to show without scrolling.
 */
export interface DisplayFrameExtent {
  readonly type: 'world:display-extent'
  readonly kind: 'advice' | 'generated'
  readonly minWidth: number
  readonly width: number
  readonly height: number
}

/** Frame -> window: a zoom gesture made inside the frame (keys or Ctrl/pinch wheel). */
export type DisplayFrameZoomRequest =
  | { readonly type: 'world:display-zoom'; readonly step: 'in' | 'out' | 'reset' }
  | { readonly type: 'world:display-zoom'; readonly factor: number }

/**
 * Frame -> window: show this display of the same Run in the window, after
 * this one (equipment a safety function chip or a banner label names, opened
 * from an answer's display; a dashboard of another scope, opened from a
 * dashboard); Back returns here.
 */
export interface DisplayFrameOpen {
  readonly type: 'world:display-open'
  /** The display's state, as its view publication carries it. */
  readonly state: string
  readonly title: string
  /** What draws it: a vignette, or a dashboard (a dashboard's sections open vignettes, its scopes dashboards). */
  readonly viewType: WorldViewType
}

/**
 * Frame -> window: frame the live map on these bounds, [west, south] and
 * [east, north] in degrees (a vignette's "Show on map"; World computed them
 * from the Run's objects).
 */
export interface DisplayFrameMap {
  readonly type: 'world:display-map'
  readonly bounds: readonly [readonly [number, number], readonly [number, number]]
}

/** Frame -> window: Back, to the display this one was opened from. */
export interface DisplayFrameBack {
  readonly type: 'world:display-back'
}

/**
 * Frame -> window: whether the display asks for the body's whole height: a faceplate stands open or pinned on it (not
 * cut at a short display's foot while the window has room, W3.4), or it shows alerts only, its list filling the window
 * (W2.5). Meanwhile the window gives the frame at least the body's height.
 */
export interface DisplayFrameFill {
  readonly type: 'world:display-fill'
  readonly fill: boolean
}

/**
 * Window -> frame: select this element where the display draws it, once (an alarm strip's group row opens its unit's
 * display with its first-out selected, W2.8): its item outlined and its faceplate open.
 */
export interface DisplayFrameSelect {
  readonly type: 'world:display-select'
  readonly objectId: string
  readonly elementId: string
}

export const parseDisplayFrameSelect = (value: unknown): DisplayFrameSelect | null =>
  isRecord(value) && value.type === 'world:display-select' && hasKeys(value, ['type', 'objectId', 'elementId']) && text(value.objectId, 200) && text(value.elementId, 200)
    ? { type: 'world:display-select', objectId: value.objectId, elementId: value.elementId } : null

export type DisplayFrameMessage = DisplayFrameReady | DisplayFrameExtent | DisplayFrameZoomRequest | DisplayFrameOpen | DisplayFrameMap | DisplayFrameBack | DisplayFrameFill

/** The longest state and title an open request carries (a detail's state is far shorter). */
const OPEN_STATE_MAX = 4_096
const OPEN_TITLE_MAX = 120
/** The most proposals, details, components and characters a proposals message carries. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const hasKeys = (record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(record).sort().join() === [...keys].sort().join()

const text = (value: unknown, most: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= most

const room = (value: unknown): value is DisplayFrameRoom => isRecord(value) && hasKeys(value, ['x', 'y', 'width', 'height'])
  && [value.x, value.y].every(number => typeof number === 'number' && Number.isFinite(number)) && [value.width, value.height].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0)

export const parseDisplayFramePresentation = (value: unknown): DisplayFramePresentation | null => {
  if (!isRecord(value) || value.type !== 'world:display-frame') return null
  const optional = ['back', 'visible'].filter(key => key in value)
  if (!hasKeys(value, ['type', 'shown', 'zoom', ...optional])) return null
  if (typeof value.shown !== 'boolean' || !finitePositive(value.zoom)) return null
  if (value.zoom < DISPLAY_ZOOM_MIN || value.zoom > DISPLAY_ZOOM_MAX) return null
  if ('back' in value && !text(value.back, OPEN_TITLE_MAX)) return null
  if ('visible' in value && !room(value.visible)) return null
  return {
    type: 'world:display-frame', shown: value.shown, zoom: value.zoom,
    ...(typeof value.back === 'string' ? { back: value.back } : {}),
    ...(room(value.visible) ? { visible: { x: value.visible.x, y: value.visible.y, width: value.visible.width, height: value.visible.height } } : {}),
  }
}

export const parseDisplayFrameMessage = (value: unknown): DisplayFrameMessage | null => {
  if (!isRecord(value)) return null
  if (value.type === 'world:display-frame-ready') return hasKeys(value, ['type']) ? { type: 'world:display-frame-ready' } : null
  if (value.type === 'world:display-extent') {
    if (!hasKeys(value, ['type', 'kind', 'minWidth', 'width', 'height'])) return null
    if (value.kind !== 'advice' && value.kind !== 'generated') return null
    if (!finitePositive(value.minWidth) || !finitePositive(value.width) || !finitePositive(value.height)) return null
    return { type: 'world:display-extent', kind: value.kind, minWidth: value.minWidth, width: value.width, height: value.height }
  }
  if (value.type === 'world:display-zoom') {
    if (hasKeys(value, ['type', 'step']) && (value.step === 'in' || value.step === 'out' || value.step === 'reset')) {
      return { type: 'world:display-zoom', step: value.step }
    }
    if (hasKeys(value, ['type', 'factor']) && finitePositive(value.factor)) return { type: 'world:display-zoom', factor: value.factor }
    return null
  }
  if (value.type === 'world:display-open') {
    if (!hasKeys(value, ['type', 'state', 'title', 'viewType']) || !text(value.state, OPEN_STATE_MAX) || !text(value.title, OPEN_TITLE_MAX)) return null
    if (value.viewType !== VIGNETTE_VIEW_TYPE && value.viewType !== DASHBOARD_VIEW_TYPE) return null
    return { type: 'world:display-open', state: value.state, title: value.title, viewType: value.viewType }
  }
  if (value.type === 'world:display-map') {
    const corner = (point: unknown): point is readonly [number, number] => Array.isArray(point) && point.length === 2
      && typeof point[0] === 'number' && typeof point[1] === 'number' && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90
    if (!hasKeys(value, ['type', 'bounds']) || !Array.isArray(value.bounds) || value.bounds.length !== 2) return null
    const [southWest, northEast] = value.bounds as unknown[]
    if (!corner(southWest) || !corner(northEast) || southWest[0] > northEast[0] || southWest[1] > northEast[1]) return null
    return { type: 'world:display-map', bounds: [[southWest[0], southWest[1]], [northEast[0], northEast[1]]] }
  }
  if (value.type === 'world:display-back') return hasKeys(value, ['type']) ? { type: 'world:display-back' } : null
  if (value.type === 'world:display-fill') return hasKeys(value, ['type', 'fill']) && typeof value.fill === 'boolean' ? { type: 'world:display-fill', fill: value.fill } : null
  return null
}
