import type { OperationalObject } from '../../core/model/index.ts'
import { createWorldPackDescriptor, type PackObjectField, type PackObjectPresentation, type PackObjectPresentationContext, type PackObjectStatusPresentation, type WorldPackView } from '../../core/packs/protocol.ts'
import { packField } from '../../core/packs/presentation.ts'
import { plannedWaypointFeatures, queuedPlanRoutesQuery } from './chain-path.ts'
import { einsatzColors } from './colors.ts'
import type { TaskData } from './engine/model.ts'
import { einsatzPackId, einsatzRuntimeId } from './ids.ts'
import { neutralLexicon, type UnitPhase } from './lexicon.ts'
import { contactIcon } from './text.ts'
import { dispatchWords } from './ui/dispatch-words.ts'
import { einsatzRecordOf, tierWord, trackAgeText, type EinsatzRecord } from './ui/presenters.ts'

/**
 * The browser-safe Einsatz view. It reads only the presentation each object
 * carries and imports no engine, configuration validation or map catalogue.
 *
 * Einsatz objects use their catalogue icons: a unit or site its type's,
 * an open task its template's, a track its identified type's or, as a
 * contact, a neutral one. A track shows only what its side knows. A contact
 * has a neutral icon and colour and no type, side or weapon range; an
 * identified track shows the type's icon and label, the side and the range;
 * a destroyed track keeps what it had and is muted. A side's track index,
 * which names the unit each track follows, reaches truth roles only and is
 * never drawn on the map.
 *
 * The map draws each unit’s active route. For the selected unit, it asks
 * the runtime for the queued travel legs and draws them as dotted routes.
 *
 * Map labels: a unit shows its callsign and a short code of its phase, and
 * whether it is damaged; a place that does not move, its name, and whether
 * it is damaged or destroyed, but no phase and no free or committed status;
 * a receiving site, its name and whether it is
 * closed; a task, its label; a track, its serial and the age of its last
 * detection. Committed assets and calls with all needs covered recede.
 * A call with uncovered needs keeps its pulsing status, even after a
 * partial allocation. Completed calls keep a small history dot.
 *
 * The Dispatch panel is the Pack's one surface panel and its only list, so
 * no category takes a rail section. Open by default, it takes every map
 * target click of an Einsatz unit; the map keeps its gestures but
 * double-click zoom, so a double-click on an object acts as one click. A
 * unit that moves is a map controller: a click on one selects it, and with
 * it selected every other click is the panel's to read (`ui/selection.ts`),
 * which decides whether the selected unit can dispatch. A site, a task and a track are
 * never controllers.
 */

/** The Dispatch panel's id: its first segment names the Pack whose data revisions reach it. */
export const einsatzDispatchPanelId = 'einsatz.dispatch'

const unitsCategory = 'einsatz-units'
const tasksCategory = 'einsatz-tasks'
const tracksCategory = 'einsatz-tracks'
const trackIndexesCategory = 'einsatz-track-indexes'
const { unit: unitColor, task: taskColor, identified: identifiedColor, contact: contactColor } = einsatzColors
const trackIndexIcon = 'network'

/** Short neutral codes of the closed phase set for map labels; the Dispatch panel words each phase from the configuration. */
const phaseCodes: Readonly<Record<UnitPhase, string>> = {
  available: 'AV',
  mobilizing: 'MOB',
  'en-route': 'ER',
  'on-task': 'OT',
  transporting: 'TR',
  'at-site': 'AS',
  returning: 'RT',
  holding: 'HD',
  destroyed: 'X',
}

type UnitData = Extract<EinsatzRecord, { type: 'unit' }>
type TrackData = Extract<EinsatzRecord, { type: 'track' }>

const typeOf = (object: OperationalObject): EinsatzRecord['type'] | null => object.packId === einsatzPackId ? einsatzRecordOf(object).type : null

/** An Einsatz unit that moves: the map selects it to give it orders through the Dispatch panel. */
const isMovingUnit = (object: OperationalObject): boolean => typeOf(object) === 'unit' && object.kind === 'mobile_entity'

const dot = { shape: 'dot' } as const

/** Neutral map status for a free, committed or destroyed unit. */
const unitStatus = (data: UnitData): PackObjectStatusPresentation => {
  if (data.integrity === 'destroyed') return { tone: 'error', label: neutralLexicon.destroyed, indicator: dot }
  const committed = data.taskId !== undefined || Object.values(data.load).some(count => count > 0)
    || (Array.isArray(data.orders) && data.orders.length > 0)
  return committed ? { tone: 'working', label: 'Committed', indicator: dot } : { tone: 'ready', label: 'Free', indicator: dot }
}

/** A unit's callsign, its phase code and whether it is damaged; a place that never moves (an objective, a post) has no phase to show but its loss. */
const unitLabel = (object: OperationalObject, data: UnitData): string => {
  const phase = object.kind === 'facility' && data.phase !== 'destroyed' ? [] : [phaseCodes[data.phase]]
  const parts = [object.label, ...phase, ...(data.integrity === 'damaged' ? ['DMG'] : [])]
  return parts.join(' · ')
}

/** The track's serial and, while the Run clock is known, the age of its last detection. */
const trackLabel = (object: OperationalObject, context: PackObjectPresentationContext): string => {
  const age = trackAgeText(object, context.currentTime === undefined ? null : Date.parse(context.currentTime))
  return age === null ? object.label : `${object.label} · ${age}`
}

const presentTrack = (object: OperationalObject, data: TrackData, context: PackObjectPresentationContext): PackObjectPresentation => {
  const identity = data.identity
  const fields: PackObjectField[] = [
    packField('tier', 'Tier', tierWord(data.tier)),
    packField('fix', 'Fire-control fix', data.fix ? 'Yes' : 'No'),
    ...(identity === undefined ? [] : [
      packField('type', 'Type', identity.typeLabel),
      packField('side', 'Side', identity.side),
      ...(identity.rangeM === undefined ? [] : [packField('range', 'Weapon range', `${(identity.rangeM / 1_000).toFixed(1)} km`)]),
    ]),
  ]
  return {
    categoryId: tracksCategory,
    icon: identity?.icon ?? contactIcon,
    color: identity === undefined ? contactColor : identifiedColor,
    summary: identity === undefined ? tierWord(data.tier) : `${tierWord(data.tier)} · ${identity.typeLabel}`,
    muted: data.tier === 'destroyed' || object.lifecycle !== 'active',
    fields,
    mapLabel: trackLabel(object, context),
  }
}

/** Compare all counted needs, so a partly assigned call stays prominent. Reports have no counted needs. */
const fullyCovered = (coverage: TaskData['coverage'] | undefined): boolean =>
  coverage !== undefined
  && coverage.requirements.length + coverage.loads.length > 0
  && coverage.requirements.every(need => need.enRoute + need.onTask + need.completed >= need.count)
  && coverage.loads.every(need => need.covered >= need.waiting)

const waitingStatus = (object: OperationalObject): PackObjectStatusPresentation => ({ tone: 'idle', label: object.operational.status, indicator: { shape: 'dot', pulse: true } })

const presentEinsatzObject = (object: OperationalObject, context: PackObjectPresentationContext): PackObjectPresentation => {
  const data = einsatzRecordOf(object)
  switch (data.type) {
    case 'unit': {
      // A site that receives load carries its accepting state.
      const receiving = data.accepting !== undefined
      const status = unitStatus(data)
      const unavailable = data.accepting === false || (object.kind === 'mobile_entity' && status.tone !== 'ready')
      return {
        categoryId: unitsCategory,
        icon: data.presentation.icon,
        color: unitColor,
        summary: data.presentation.typeLabel,
        muted: object.lifecycle !== 'active' || data.integrity === 'destroyed',
        fields: [],
        ...(unavailable ? { mapMarker: 'muted' as const } : {}),
        ...(receiving ? { mapLabel: data.accepting === true ? object.label : `${object.label} · closed` } : { mapLabel: unitLabel(object, data), ...(object.kind === 'facility' && data.integrity !== 'destroyed' ? {} : { status }) }),
      }
    }
    case 'task': {
      const summary = data.presentation.typeLabel
      const coverage = data.coverage as TaskData['coverage'] | undefined
      const covered = fullyCovered(coverage)
      const lastAction = data.lastAction as TaskData['lastAction']
      const closed = object.lifecycle !== 'active'
      return {
        categoryId: tasksCategory,
        icon: data.presentation.icon,
        color: taskColor,
        summary,
        fields: [],
        ...(closed
          ? { mapMarker: 'dot', muted: true, glance: [summary, lastAction?.verb === 'close' ? (lastAction.cause ?? 'Closed') : 'Completed'] }
          : { mapLabel: object.label, ...(covered ? { mapMarker: 'muted', glance: [summary, 'All needs covered'] } : { status: waitingStatus(object) }) }),
      }
    }
    case 'track':
      return presentTrack(object, data, context)
    case 'track-index':
      return {
        categoryId: trackIndexesCategory,
        icon: trackIndexIcon,
        color: contactColor,
        summary: `${Object.keys(data.subjects).length} ${neutralLexicon.tracks.toLowerCase()} · ${data.side}`,
        mapIconVisible: false,
        fields: [packField('side', 'Side', data.side)],
      }
  }
}

export const einsatzPackView = {
  descriptor: createWorldPackDescriptor({
    id: einsatzPackId,
    version: '1.0.0',
    name: 'Einsatz',
    description: 'Dispatch and command of configured units: unit types, typed properties, task templates, load classes and wording are scenario data. Units move by road or in straight lines, serve and carry counted demand to receiving sites, and follow closed standing orders. An open Run declares no roles or sides; declaring roles makes the Run refuse AI. Valid icon ids come from world.map.symbols.',
    contributions: ['runtime', 'knowledge', 'scenario', 'presentation', 'targeting', 'interactions'],
  }),
  runtime: {
    runtimes: [{ id: einsatzRuntimeId, version: '1.0.0', label: 'Local Einsatz runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: einsatzRuntimeId,
  },
  presentation: {
    // The Dispatch panel is the only list, so no category takes a rail section.
    categories: [
      { id: unitsCategory, label: neutralLexicon.units, emptyLabel: neutralLexicon.noUnits, matches: object => typeOf(object) === 'unit', rail: false },
      { id: tasksCategory, label: neutralLexicon.calls, emptyLabel: neutralLexicon.noCalls, matches: object => typeOf(object) === 'task', rail: false },
      { id: tracksCategory, label: neutralLexicon.tracks, emptyLabel: `No ${neutralLexicon.tracks.toLowerCase()}`, matches: object => typeOf(object) === 'track', rail: false },
      { id: trackIndexesCategory, label: 'Track indexes', emptyLabel: 'No track indexes', matches: object => typeOf(object) === 'track-index', rail: false },
    ],
    presentObject: (object, context) => presentEinsatzObject(object, context),
    mapFeatures: context => plannedWaypointFeatures(context.objects, unitsCategory, context.selectedObjectId),
    mapFeatureQueries: context => queuedPlanRoutesQuery(context.objects, context.selectedObjectId),
    mapFeaturesFollowSelection: true,
    mapFeatureLayers: ['routes'],
    mapFeatureSourcePackIds: [einsatzPackId],
  },
  targeting: {
    isController: object => isMovingUnit(object),
    // Every map order for an Einsatz unit goes to the open Dispatch panel's `onMapTarget`; the generic surface never sends one.
    isTarget: () => false,
    buildSetTargetCommand: controller => { throw new Error(`Einsatz map orders go through the Dispatch panel, never the generic map path: ${controller.id}`) },
    buildCancelTargetCommand: controller => { throw new Error(`Einsatz map orders go through the Dispatch panel, never the generic map path: ${controller.id}`) },
  },
  ui: {
    surfacePanels: [{
      id: einsatzDispatchPanelId,
      label: dispatchWords.panel,
      defaultOpen: true,
      mapTargets: true,
      load: async () => await import('./ui/DispatchPanel.svelte'),
    }],
    mapInteraction: { doubleClickZoom: false },
    surfaceLayout: { railCollapsed: true },
  },
} satisfies WorldPackView
