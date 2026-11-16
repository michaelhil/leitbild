import type { GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject, SimulationRunId } from '../core/model/index.ts'
import type { ActivePackViews } from '../core/packs/active-views.ts'
import type { PackMapTarget, PackSurfacePanelContribution, PackTargetContext, PackTargetPreview, WorldPackView } from '../core/packs/protocol.ts'
import type { PanelKey } from './keys/panel-key.ts'
import type { MapCover, PanelRoleSet } from './surface-panel-contract.ts'
import type { CameraInteraction } from './map/map-camera.ts'
import type { MapFocusTarget, MapView } from './map-view.ts'

/**
 * What a mounted surface panel lends the World surface. A panel connects
 * exactly the handlers its contribution declares: `onMapTarget` with
 * `mapTargets`, `onKey` with `keymap`; `previewMapTarget` is optional and
 * only with `mapTargets`.
 */
export interface SurfacePanelInteraction {
  /**
   * Every map target click while a controller of the panel's own Pack is
   * selected; the surface never sends one itself. A controller of another
   * Pack keeps that Pack's generic targeting and never reaches the panel.
   */
  readonly onMapTarget?: (controllerId: ObjectId, target: PackMapTarget) => void
  /**
   * The hover preview of a target for such a controller: verb and ETA, or
   * the refusal, answered synchronously from what the panel already holds
   * (its recommendation cache). It replaces the Pack's describeTarget for
   * those controllers; null shows no preview.
   */
  readonly previewMapTarget?: (controllerId: ObjectId, target: PackMapTarget) => PackTargetPreview | null
  /** A key the World key router let through; true when the panel handled it. */
  readonly onKey?: (key: PanelKey) => boolean
}

/** One button of a map prompt; a warning one names work it drops, e.g. "Now (drops C-3 · P3)". */
export interface MapPromptOption {
  readonly label: string
  readonly tone?: 'default' | 'warning'
  readonly onConfirm: () => void
}

/**
 * A prompt a map-target panel shows at a point on the map, such as "Move
 * here" after a tap on open ground, or "After current job" and "Now (drops
 * …)" for a busy unit: one or two buttons, in the order given. The map draws
 * them offset above or beside the point, never under it, so the finger or
 * pointer that made the tap does not land on one; a tap on a button confirms
 * it. A tap anywhere else on the map, the prompt's × or Esc dismisses it
 * without confirming: the surface drops the prompt and calls `onDismiss`
 * once, and the panel forgets it, so it never shows that prompt again. A
 * prompt the panel replaces or clears itself is not dismissed.
 */
export interface MapPrompt {
  readonly point: GeoJsonPoint
  readonly options: ReadonlyArray<MapPromptOption>
  readonly onDismiss: () => void
}

/** A panel's prompt, refused unless it has one or two options, each with a label. */
export const assertMapPrompt = (panelId: string, prompt: MapPrompt): MapPrompt => {
  if (prompt.options.length < 1 || prompt.options.length > 2) throw new Error(`Surface panel ${panelId} showed a map prompt with ${prompt.options.length} options; a prompt has one or two`)
  const unlabelled = prompt.options.findIndex(option => option.label.trim().length === 0)
  if (unlabelled >= 0) throw new Error(`Surface panel ${panelId} showed a map prompt whose option ${unlabelled + 1} has no label`)
  return prompt
}

/** The most tags one map targeting shows; a panel tags the nearest few of its targets. */
export const mapTargetingMaxTags = 8

/**
 * One target an armed order marks. A valid one (the default) gets a green
 * halo; the nearest few also carry a tag, the verb or ETA a click there
 * gives, e.g. "4 min". A refused one is the target a click was just refused
 * for: it gets a neutral ring apart from the valid ones, and its tag is the
 * refusal, shown beside the target for as long as the panel keeps it in the
 * targeting (plan B.3: 4 s).
 */
export interface MapTargetingTarget {
  readonly id: ObjectId
  /** Worded when given; a refused target always has one, a valid one only among the nearest. */
  readonly tag?: string
  readonly tone?: 'valid' | 'refused'
}

/**
 * What a map-target panel shows on the map while it arms an order for one
 * of its objects, `from`: each target gets a halo, tagged or not
 * (`MapTargetingTarget`), and a line runs from `from` to a mouse pointer
 * (never to a finger, which has none between taps). Once `complete`,
 * `targets` lists every valid target, and every other object is dimmed: a
 * dimmed object is never one the order would take. Until then (the panel is
 * still reading them) nothing is dimmed. The map only draws it; clicks route
 * as always (`map-target-routing.ts`), a tap on a tag is a tap on its
 * target, and a tap on a stack of icons offers only its valid targets.
 */
export interface MapTargeting {
  readonly from: ObjectId
  readonly targets: ReadonlyArray<MapTargetingTarget>
  readonly complete: boolean
}

/** A panel's targeting, refused beyond eight tags, with a target twice or as `from`, with an empty tag, or with a refused target untagged. */
export const assertMapTargeting = (panelId: string, targeting: MapTargeting): MapTargeting => {
  const refuse = (reason: string): never => { throw new Error(`Surface panel ${panelId} showed a map targeting from ${targeting.from} ${reason}`) }
  const tags = targeting.targets.filter(target => target.tag !== undefined).length
  if (tags > mapTargetingMaxTags) refuse(`with ${tags} tags; at most ${mapTargetingMaxTags} are shown`)
  const ids = new Set<ObjectId>()
  for (const target of targeting.targets) {
    if (target.id === targeting.from) refuse('that targets its own object')
    if (ids.has(target.id)) refuse(`that marks ${target.id} twice`)
    if (target.tag !== undefined && target.tag.trim().length === 0) refuse(`whose target ${target.id} has an empty tag`)
    if (target.tone === 'refused' && target.tag === undefined) refuse(`whose refused target ${target.id} has no tag`)
    ids.add(target.id)
  }
  return targeting
}

export const noMapCover: MapCover = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })

const coverEdges = ['top', 'right', 'bottom', 'left'] as const

/** A panel's report, refused when an edge is not a finite, non-negative length. */
export const assertMapCover = (panelId: string, cover: MapCover): MapCover => {
  const wrong = coverEdges.filter(edge => !Number.isFinite(cover[edge]) || cover[edge] < 0)
  if (wrong.length > 0) throw new Error(`Surface panel ${panelId} reported a map cover that is no length: ${wrong.map(edge => `${edge} ${cover[edge]}`).join(', ')}`)
  return cover
}

/**
 * The map camera's padding: per edge, the farthest any open panel reaches
 * over the map, so the camera centres and fits within the part left clear.
 */
export const cameraPaddingFor = (covers: ReadonlyArray<MapCover>): MapCover => ({
  top: Math.max(0, ...covers.map(cover => cover.top)),
  right: Math.max(0, ...covers.map(cover => cover.right)),
  bottom: Math.max(0, ...covers.map(cover => cover.bottom)),
  left: Math.max(0, ...covers.map(cover => cover.left)),
})

/** The props the World surface passes to every surface panel. */
export interface SurfacePanelProps {
  readonly simulationRunId: SimulationRunId
  /** The screen's projection: for a role, its own view of the Run. */
  readonly objects: ReadonlyArray<OperationalObject>
  readonly mapView: MapView | null
  /** The newest `pack.data.changed` revision of the panel's Pack (the panel id's first segment). */
  readonly dataRevision: number
  readonly selectedItemId: string | null
  readonly onSelectItem: (itemId: string | null) => void
  readonly onClose: () => void
  readonly onFocusMap: (target: MapFocusTarget) => void
  /** Simulation time now, read on demand; it stands still while the Run is paused. */
  readonly currentTime: () => IsoTimestamp | undefined
  /** The one selection the panel shares with the map. */
  readonly selectedObjectId: ObjectId | null
  /** Selects an object, on the map and for its orders, or clears the selection. */
  readonly onSelectObject: (objectId: ObjectId | null) => void
  /** Lends the declared handlers while the panel is mounted; returns their release. */
  readonly connectInteraction: (interaction: SurfacePanelInteraction) => () => void
  /** False while the World window lacks focus, so no key can reach the panel. */
  readonly keysActive: boolean
  /** The role set this screen plays; null in a Run that declares no roles. A role switch remounts the panel. */
  readonly roleSet: PanelRoleSet | null
  /**
   * Reports how far the panel reaches over the map, from its observed size;
   * the map camera then centres and fits clear of it. Only open panels'
   * latest reports count.
   */
  readonly onMapCover: (cover: MapCover) => void
  /**
   * In a role Run, the roles this screen shows (the role dialog's See boxes;
   * every held role is shown); null in open mode. A display filter only: the
   * panel may hide its own Pack's objects of roles not shown, never anything
   * the Run's per-side visibility decides.
   */
  readonly seenRoleIds: ReadonlyArray<string> | null
  /**
   * Shows a prompt at a point on the map, or clears it with null. Only the
   * open map-target panel's latest prompt is shown; a panel clears its own
   * when it unmounts. When the operator dismisses it, the surface drops it
   * and calls its `onDismiss`.
   */
  readonly onMapPrompt: (prompt: MapPrompt | null) => void
  /**
   * Shows an armed order's targets on the map (`MapTargeting`), or clears
   * them with null. Only the open map-target panel's latest targeting is
   * drawn; a panel clears its own when it unmounts.
   */
  readonly onMapTargeting: (targeting: MapTargeting | null) => void
}

/** A panel connects the handlers its contribution declares, and only those. */
export const assertPanelInteraction = (panel: PackSurfacePanelContribution, interaction: SurfacePanelInteraction): void => {
  if ((panel.mapTargets === true) !== (interaction.onMapTarget !== undefined)) {
    throw new Error(`Surface panel ${panel.id} ${panel.mapTargets ? 'declares map targets but connects no onMapTarget' : 'connects onMapTarget without declaring map targets'}`)
  }
  if (interaction.previewMapTarget !== undefined && panel.mapTargets !== true) {
    throw new Error(`Surface panel ${panel.id} connects previewMapTarget without declaring map targets`)
  }
  if ((panel.keymap === true) !== (interaction.onKey !== undefined)) {
    throw new Error(`Surface panel ${panel.id} ${panel.keymap ? 'declares a keymap but connects no onKey' : 'connects onKey without declaring a keymap'}`)
  }
}

/** The open panel that declares the hook, if any; active Pack views admit at most one per hook. */
export const openPanelDeclaring = (
  panels: ReadonlyArray<PackSurfacePanelContribution>,
  isOpen: (panel: PackSurfacePanelContribution) => boolean,
  hook: 'mapTargets' | 'keymap',
): PackSurfacePanelContribution | null =>
  panels.find(panel => panel[hook] === true && isOpen(panel)) ?? null

/**
 * The Pack that contributes a surface panel, found by the panel's id: the
 * route holds its active Pack views in deep state, whose proxies differ per
 * path, so the same panel reached through two paths is never the same object.
 */
export const surfacePanelPackId = (packs: ReadonlyArray<WorldPackView>, panel: PackSurfacePanelContribution): string => {
  const owner = packs.find(pack => pack.ui?.surfacePanels.some(candidate => candidate.id === panel.id) === true)
  if (!owner) throw new Error(`Surface panel ${panel.id} belongs to no active Pack`)
  return owner.descriptor.id
}

/**
 * The controller a screen starts with selected, at join and after a role
 * switch: the first one it may command, unless an open panel takes map
 * targets. That panel owns the selection, which then starts empty and moves
 * only by the operator or the panel.
 */
export const startingControllerId = (
  objects: ReadonlyArray<OperationalObject>,
  pack: Pick<ActivePackViews, 'targeting' | 'surfacePanels'>,
  context: PackTargetContext,
  isOpen: (panel: PackSurfacePanelContribution) => boolean,
): ObjectId | null => {
  if (openPanelDeclaring(pack.surfacePanels, isOpen, 'mapTargets') !== null) return null
  return objects.find(object => pack.targeting?.isController(object, context) === true)?.id ?? null
}

/** The camera gestures the map keeps on: each is off only when an active Pack switches it off. */
export const mapCameraInteractionFor = (packs: ReadonlyArray<WorldPackView>): CameraInteraction => {
  const declared = packs.flatMap(pack => pack.ui?.mapInteraction ? [pack.ui.mapInteraction] : [])
  return {
    doubleClickZoom: !declared.some(interaction => interaction.doubleClickZoom === false),
    keyboard: !declared.some(interaction => interaction.keyboard === false),
    boxZoom: !declared.some(interaction => interaction.boxZoom === false),
  }
}

/** Whether the surface starts with the control rail collapsed. */
export const railStartsCollapsed = (packs: ReadonlyArray<WorldPackView>): boolean =>
  packs.some(pack => pack.ui?.surfaceLayout?.railCollapsed === true)

/**
 * Whether a surface panel is open: what this tab chose for it, else the
 * panel's declared `defaultOpen`. A panel the tab never touched opens as its
 * Pack declares, so a Pack whose only list and map-target handler is its
 * panel (Einsatz) is usable without first finding it in the View menu.
 */
export const surfacePanelIsOpen = (panel: Pick<PackSurfacePanelContribution, 'id' | 'defaultOpen'>, chosen: Readonly<Record<string, boolean>>): boolean =>
  chosen[panel.id] ?? panel.defaultOpen
