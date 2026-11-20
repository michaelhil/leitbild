import type { GeoJsonPoint, ObjectId, OperationalObject } from '../core/model/index.ts'
import type { PackCommandRequest, PackMapTarget, PackTargetContext, PackTargetingContribution, PackTargetPreview } from '../core/packs/protocol.ts'

/**
 * Where a map click goes. Without a map-target panel the generic surface
 * selects controllers and sends the Pack's target command, as it always has;
 * while an open panel declares map targets, every target click for a
 * controller of the panel's own Pack goes to that panel and the surface never
 * sends one, a second click on the selected controller included. A controller
 * of another Pack keeps the generic path. A click that orders nothing, with no
 * unit chosen and no such panel open, opens the object's display where its Pack
 * asks so (`PackUiContribution.displayOnPress`).
 *
 * A Pack that declares a map-target panel takes no click on its objects
 * through the generic path: while that panel is closed, a click on one of its
 * objects opens the panel with the object selected, and while it is open the
 * click reaches the panel or selects the object for it. No click on such an
 * object is ever ignored. While that panel is open, a click on open ground
 * with an object selected that is not a controller clears the selection: the
 * ground means "away" (plan B.3, a call or a site card closes).
 */

/** The open panel declaring map targets, with its handlers once it has connected them. */
export interface MapTargetPanel {
  readonly label: string
  /** The Pack that contributes the panel; it takes orders only for that Pack's controllers. */
  readonly packId: string
  readonly onMapTarget: ((controllerId: ObjectId, target: PackMapTarget) => void) | null
  /** The panel's own hover preview, e.g. from its recommendation cache; null when it connected none. */
  readonly previewMapTarget: ((controllerId: ObjectId, target: PackMapTarget) => PackTargetPreview | null) | null
}

/** A surface panel that declares map targets and is closed: a click on an object of its Pack opens it. */
export interface ClosedMapTargetPanel {
  readonly panelId: string
  /** The Pack that contributes the panel. */
  readonly packId: string
}

export interface MapClickContext {
  /** The selected controller, if the selection is one. */
  readonly controller: OperationalObject | null
  /** The one selection the screen shares with its panels, a controller or not. */
  readonly selectedObjectId: ObjectId | null
  readonly targeting: PackTargetingContribution | undefined
  readonly context: PackTargetContext
  readonly panel: MapTargetPanel | null
  /** Every closed panel that declares map targets, with its Pack. */
  readonly closedMapTargetPanels: ReadonlyArray<ClosedMapTargetPanel>
  /** Whether a click on the object opens its display in the display window, when the click orders nothing. */
  readonly opensDisplay: (object: OperationalObject) => boolean
}

export type MapClickRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'select'; readonly objectId: ObjectId; readonly note: string | null }
  | { readonly kind: 'panel'; readonly controllerId: ObjectId; readonly target: PackMapTarget }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'send'; readonly command: PackCommandRequest; readonly subject: string }
  | { readonly kind: 'display'; readonly objectId: ObjectId }
  /** Open the closed map-target panel of the object's Pack and select the object for it. */
  | { readonly kind: 'openPanel'; readonly panelId: string; readonly objectId: ObjectId }
  /** Clear the shared selection: open ground under an open map-target panel, with no controller selected. */
  | { readonly kind: 'deselect' }

const none: MapClickRoute = { kind: 'none' }

/**
 * The clicks of a map shown alone (a screen's map surface, `surface-route.ts`).
 * Nothing there shows an order or cancels one: no rail, no panel. So no unit
 * is ever chosen, no Pack targeting applies and no panel takes a click. Every
 * routing function here then answers that a click orders nothing and selects
 * nothing: it opens the object's display where its Pack opens one, and
 * otherwise does nothing.
 */
export const mapAloneClicks = (click: Pick<MapClickContext, 'context' | 'opensDisplay'>): MapClickContext => ({
  controller: null,
  selectedObjectId: null,
  targeting: undefined,
  context: click.context,
  panel: null,
  closedMapTargetPanels: [],
  opensDisplay: click.opensDisplay,
})

/** The open map-target panel when it takes this controller's orders: only its own Pack's controllers. */
const panelFor = (panel: MapTargetPanel | null, controller: OperationalObject): MapTargetPanel | null =>
  panel !== null && controller.packId === panel.packId ? panel : null

const toPanel = (panel: MapTargetPanel, controllerId: ObjectId, target: PackMapTarget): MapClickRoute =>
  panel.onMapTarget === null
    ? { kind: 'note', text: `${panel.label} is still loading; map orders wait for it` }
    : { kind: 'panel', controllerId, target }

const previewOf = (click: MapClickContext, controller: OperationalObject, target: PackMapTarget): PackTargetPreview | null =>
  click.targeting?.describeTarget?.(controller, target, click.context) ?? null

/** A refusal the Pack worded is shown; any other non-target click stays as quiet as it always was. */
const notTargeted = (preview: PackTargetPreview | null): MapClickRoute =>
  preview?.refused ? { kind: 'note', text: preview.text } : none

const send = (command: PackCommandRequest, preview: PackTargetPreview | null, subject: string): MapClickRoute =>
  preview?.refused ? { kind: 'note', text: preview.text } : { kind: 'send', command, subject: preview?.text ?? subject }

/** A click on an object for a controller with no panel taking its orders: the Pack's generic targeting decides. */
const genericObjectClick = (object: OperationalObject, controller: OperationalObject, click: MapClickContext): MapClickRoute => {
  const { targeting, context, panel } = click
  if (!targeting || object.id === controller.id) return none
  const target: PackMapTarget = { kind: 'object', objectId: object.id }
  const preview = previewOf(click, controller, target)
  if (!targeting.isTarget(controller, object, context)) {
    // An object of the open map-target panel's Pack is never ignored: it becomes the selection the panel shows.
    if (panel !== null && object.packId === panel.packId) return { kind: 'select', objectId: object.id, note: preview?.refused ? preview.text : null }
    return notTargeted(preview)
  }
  return send(targeting.buildSetTargetCommand(controller, object, context), preview, `Sending ${controller.label} to ${object.label}`)
}

export const routeObjectClick = (object: OperationalObject, click: MapClickContext): MapClickRoute => {
  const { controller, targeting, context, panel } = click
  const closedPanel = click.closedMapTargetPanels.find(candidate => candidate.packId === object.packId)
  if (closedPanel) {
    // A controller of another Pack still sends to an object it targets; every other click opens the object's panel.
    const sent = controller && controller.packId !== closedPanel.packId ? genericObjectClick(object, controller, click) : null
    return sent?.kind === 'send' ? sent : { kind: 'openPanel', panelId: closedPanel.panelId, objectId: object.id }
  }
  const owningPanel = controller ? panelFor(panel, controller) : null
  if (targeting?.isController(object, context)) {
    // A second click on the selected controller is the panel's to read, e.g. a touch screen clearing the highlight.
    if (owningPanel && controller?.id === object.id) return toPanel(owningPanel, controller.id, { kind: 'object', objectId: object.id })
    return { kind: 'select', objectId: object.id, note: panelFor(panel, object) ? null : `Selected ${object.label}; click a valid target` }
  }
  // With no unit chosen, a click shares the object's selection with the panel instead of ordering anything.
  if (panel && !controller) return { kind: 'select', objectId: object.id, note: null }
  if (owningPanel && controller) return toPanel(owningPanel, controller.id, { kind: 'object', objectId: object.id })
  // With no unit chosen and no panel taking map targets, a click orders nothing: it opens the object's display, where it opens one.
  if (!controller) return click.opensDisplay(object) ? { kind: 'display', objectId: object.id } : none
  return genericObjectClick(object, controller, click)
}

/** A click on open ground, reported only while a panel or a Pack takes point targets. */
export const routeGroundClick = (point: GeoJsonPoint, click: MapClickContext): MapClickRoute => {
  const { controller, targeting, context, panel } = click
  if (!controller) return panel !== null && click.selectedObjectId !== null ? { kind: 'deselect' } : none
  const owningPanel = panelFor(panel, controller)
  if (owningPanel) return toPanel(owningPanel, controller.id, { kind: 'point', point })
  const pointTargets = targeting?.pointTargets
  if (!pointTargets) return none
  const preview = previewOf(click, controller, { kind: 'point', point })
  if (!pointTargets.isTarget(controller, point, context)) return notTargeted(preview)
  return send(pointTargets.buildSetTargetCommand(controller, point, context), preview, `Sending ${controller.label} to the map point`)
}

/** Whether open-ground clicks need reporting at all: only a map-target panel or a point-targeting Pack takes them. */
export const groundClicksWanted = (click: Pick<MapClickContext, 'targeting' | 'panel'>): boolean =>
  click.panel !== null || click.targeting?.pointTargets !== undefined

/**
 * Whether map taps pick targets for an order, so each must reach exactly the
 * object it lands on: only while an open panel takes map targets. The map
 * then lets a mouse click an icon's coloured disk, and shows a chooser for a
 * tap on overlapping icons (`OperationalMap.svelte`, `targetPicking`);
 * without such a panel every surface picks as it always has.
 */
export const targetPickingWanted = (click: Pick<MapClickContext, 'panel'>): boolean => click.panel !== null

/** Whether hovered objects can show an order preview: a panel connected one, or a Pack describes targets. */
export const targetPreviewsWanted = (click: Pick<MapClickContext, 'targeting' | 'panel'>): boolean =>
  click.panel?.previewMapTarget != null || click.targeting?.describeTarget !== undefined

/**
 * The preview a hovered object shows while a controller is selected. The
 * panel that takes the controller's orders answers when it connected a
 * preview; otherwise the Pack's describeTarget does, when it has one.
 */
export const previewObjectTarget = (object: OperationalObject, click: MapClickContext): PackTargetPreview | null => {
  const { controller, targeting, context, panel } = click
  if (!controller || object.id === controller.id) return null
  if (targeting?.isController(object, context)) return null
  const target: PackMapTarget = { kind: 'object', objectId: object.id }
  const previewMapTarget = panelFor(panel, controller)?.previewMapTarget
  if (previewMapTarget) return previewMapTarget(controller.id, target)
  return targeting?.describeTarget?.(controller, target, context) ?? null
}
