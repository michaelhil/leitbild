import {
  WORKSPACE_SURFACE_PARAMETER,
  workspaceSurfacePlaceMessageSchema,
  workspaceSurfaceStringSchema,
  type WorkspaceSurfacePlaceMessage,
} from '@leitbild/contracts'
import { objectIdSchema, type ObjectId } from '../core/model/index.ts'
import { ASSET_CAPTION, DASHBOARD_CAPTION, DASHBOARD_TITLE, type DeckEntry } from './process-display/display-deck.ts'

// A surface is one thing of a Run that its page shows filling the pane, so a
// browser window can be opened on exactly that and reopened on the same thing
// of a later Run. World owns the strings and alone reads into them. The Host
// stores and forwards them whole (packages/contracts/src/surfaces.ts); it
// offers `map:run` itself as a screen's "Map" and knows that string and
// `display:dashboard` as the two that name no object. There are four:
//
//   map:run                 the Run's map alone: no rail, dock or Pack panels
//   display:<objectId>      that observed asset's overview display
//   display:dashboard       the Run's dashboard
//   procedures:<objectId>   that unit's procedure window
//
// A string names no Workspace and no Run: object ids come from the Scenario
// Definition, so they repeat in every Run started from it. Every decision
// about a surface is made here; the Run page only asks.

export type WorldSurface =
  | { readonly kind: 'map' }
  | { readonly kind: 'display'; readonly objectId: ObjectId }
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'procedures'; readonly objectId: ObjectId }

/** What the page's address asks for: the Run page itself, one surface, or text that is no surface of World's. */
export type SurfaceRoute =
  | { readonly kind: 'run' }
  | { readonly kind: 'surface'; readonly surface: WorldSurface }
  | { readonly kind: 'unknown'; readonly text: string }

const MAP_SURFACE = 'map:run'
const DASHBOARD_SURFACE = 'display:dashboard'

/** Null for text that is none of World's surfaces. */
export const parseWorldSurface = (text: string): WorldSurface | null => {
  if (!workspaceSurfaceStringSchema.safeParse(text).success) return null
  if (text === MAP_SURFACE) return { kind: 'map' }
  if (text === DASHBOARD_SURFACE) return { kind: 'dashboard' }
  const colon = text.indexOf(':')
  const kind = text.slice(0, colon)
  if (kind !== 'display' && kind !== 'procedures') return null
  const objectId = objectIdSchema.safeParse(text.slice(colon + 1))
  return objectId.success ? { kind, objectId: objectId.data } : null
}

export const formatWorldSurface = (surface: WorldSurface): string => {
  if (surface.kind === 'map') return MAP_SURFACE
  if (surface.kind === 'dashboard') return DASHBOARD_SURFACE
  const text = `${surface.kind}:${surface.objectId}`
  // The one string an object id cannot take: it is the Run dashboard's.
  if (text === DASHBOARD_SURFACE) throw new Error('An object with the id "dashboard" has no display surface')
  return workspaceSurfaceStringSchema.parse(text)
}

/** The surface the page's query names beside the Run's own selection. */
export const readSurfaceRoute = (search: string): SurfaceRoute => {
  const text = new URLSearchParams(search).get(WORKSPACE_SURFACE_PARAMETER)
  if (text === null) return { kind: 'run' }
  const surface = parseWorldSurface(text)
  return surface === null ? { kind: 'unknown', text } : { kind: 'surface', surface }
}

/** The query that names the same surface again, where the page rewrites its own address or hands it to the Host; text that is no surface is kept, so it is still refused there. */
export const surfaceRouteQuery = (route: SurfaceRoute): Readonly<Record<string, string>> =>
  route.kind === 'run' ? {} : { [WORKSPACE_SURFACE_PARAMETER]: route.kind === 'unknown' ? route.text : formatWorldSurface(route.surface) }

/** What the joined Run offers for one object. */
export interface SurfaceSubject {
  readonly label: string
  /** World opens an overview display of it: its Pack declares observations. */
  readonly hasOverview: boolean
  /** A Pack runs procedures for it. */
  readonly runsProcedures: boolean
}

/** The Run's map alone, or the window a surface opens filling the pane, or why this Run cannot show it. */
export type SurfacePresentation =
  | { readonly kind: 'map' }
  | { readonly kind: 'display'; readonly target: { readonly kind: 'dashboard' } | { readonly kind: 'asset'; readonly objectId: ObjectId } }
  | { readonly kind: 'procedures'; readonly objectId: ObjectId }
  | { readonly kind: 'refused'; readonly reason: string }

const refusedTextLimit = 80
const quoted = (text: string): string => `“${text.length <= refusedTextLimit ? text : `${text.slice(0, refusedTextLimit)}…`}”`

/**
 * What a surface shows in the joined Run. `subjectOf` answers null for an
 * object this screen does not see; `runHasMap` is whether the Run's Starting
 * View has a map at all, never whether it has loaded. A surface the Run
 * cannot show is refused with the sentence the pane shows in its place;
 * nothing falls back to the map or to the whole page.
 */
export const presentSurface = (
  route: Exclude<SurfaceRoute, { readonly kind: 'run' }>,
  subjectOf: (objectId: ObjectId) => SurfaceSubject | null,
  runHasMap: boolean,
): SurfacePresentation => {
  if (route.kind === 'unknown') {
    return { kind: 'refused', reason: `World has nothing to show for ${quoted(route.text)}. A screen shows the Run's map, an asset's overview display, the Run's dashboard or a unit's procedures.` }
  }
  const surface = route.surface
  if (surface.kind === 'map') return runHasMap ? { kind: 'map' } : { kind: 'refused', reason: 'This Run has no map.' }
  if (surface.kind === 'dashboard') return { kind: 'display', target: { kind: 'dashboard' } }
  const subject = subjectOf(surface.objectId)
  if (subject === null) {
    return {
      kind: 'refused',
      reason: `This Run has no object ${quoted(surface.objectId)} that this screen can see, so its ${surface.kind === 'display' ? 'overview display' : 'procedures'} cannot be shown.`,
    }
  }
  if (surface.kind === 'display') {
    return subject.hasOverview
      ? { kind: 'display', target: { kind: 'asset', objectId: surface.objectId } }
      : { kind: 'refused', reason: `${subject.label} has no overview display in this Run.` }
  }
  return subject.runsProcedures
    ? { kind: 'procedures', objectId: surface.objectId }
    : { kind: 'refused', reason: `${subject.label} has no procedures in this Run.` }
}

/** A surface with what a person calls it: what "Open on another screen…" hands the Host. */
export interface TitledSurface {
  readonly surface: WorldSurface
  readonly title: string
}

const titleLimit = 120
const titled = (surface: WorldSurface, title: string): TitledSurface =>
  ({ surface, title: title.length <= titleLimit ? title : `${title.slice(0, titleLimit - 1)}…` })

/**
 * The surface a display of the window's deck is, or null where it has no
 * address: a display an answer composed, an asset that left the Run, and an
 * asset whose id is the dashboard's word.
 */
export const deckEntrySurface = (entry: DeckEntry): TitledSurface | null => {
  if (entry.source === 'dashboard') return titled({ kind: 'dashboard' }, `${DASHBOARD_TITLE} · ${DASHBOARD_CAPTION}`)
  if (entry.source !== 'asset' || !entry.inRun || entry.asset.objectId === 'dashboard') return null
  return titled({ kind: 'display', objectId: entry.asset.objectId }, `${entry.asset.label} · ${ASSET_CAPTION}`)
}

/** A unit's procedure window as a surface. */
export const procedureWindowSurface = (unit: { readonly objectId: ObjectId; readonly label: string }): TitledSurface =>
  titled({ kind: 'procedures', objectId: unit.objectId }, `Procedures · ${unit.label}`)

/** The Run whose page shows the surface. */
export interface SurfaceRun {
  readonly workspaceId: string
  readonly simulationRunId: string
}

/** The Host window this page asks, and the origin it must have. */
export interface SurfaceHost {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void }
  readonly origin: string
}

/** The request to show a surface of this page's Run on another screen, checked with the contract schema: a plain object a frame can be sent. */
export const surfacePlaceMessage = (run: SurfaceRun, placed: TitledSurface): WorkspaceSurfacePlaceMessage =>
  workspaceSurfacePlaceMessageSchema.parse({
    type: 'leitbild:surface-place',
    surface: {
      moduleId: 'world',
      subject: { workspaceId: run.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.simulationRunId },
      surface: formatWorldSurface(placed.surface),
      title: placed.title,
    },
  })

/** Asks the Host to show the surface on another screen; the Host offers its screens and remembers the choice. */
export const requestSurfacePlace = (run: SurfaceRun, placed: TitledSurface, host: SurfaceHost): void =>
  host.parent.postMessage(surfacePlaceMessage(run, placed), host.origin)
