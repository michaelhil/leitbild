// What an element's faceplate (L2, plan v5 §3, W3.2) shows besides its Pack's
// proposal and controls: at most six of the element's readings, its lead
// values as its Pack judges them each sample (a host's own before its bundled
// devices'), and at most three of its own alerts. One sample a second serves
// every faceplate a drawing has open or pinned: their elements' lead requests
// in one state, read through World's display routes as the person (a state
// names lead requests, never free refs, and shows no more than the caller may
// see), four to a state.
import type { Observation } from '../../../core/observation/model.ts'
import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
import type { VignetteElement, VignetteSample, VignetteView, VignetteValue } from '../../../features/displays/compose/model.ts'
import { underTitle } from './format.ts'
import type { DrawnSeries } from './trend.ts'
import { valueRows, type ValueRow } from './value-rows.ts'

/** The most readings and own alerts a faceplate shows (W3.2). */
export const FACEPLATE_READINGS = 6
export const FACEPLATE_ALERTS = 3
/** How tall a faceplate stands at rest, no proposal pending (W3.2): its readings give way to keep it so, whole rows from the bottom. */
export const FACEPLATE_HEIGHT_AT_REST = 300
/** The lead values a faceplate reads: more than it shows, so a host's own can lead before the readings of the devices it bundles. */
export const FACEPLATE_LEAD_ROWS = 8
/** The readings a faceplate keeps at rest: where fewer would fit beside its controls, its controls fold (shortOfRoom). */
export const FACEPLATE_READINGS_AT_REST = 3

/**
 * A host's readings in its faceplate: its own and its lines' first, in the lead's order, then those of the devices it
 * bundles (declared with it as their parent), which the faceplate also lists as links of their own (W3.2, W3.5).
 */
export const hostFirst = (values: ReadonlyArray<VignetteValue>, elementId: string): ReadonlyArray<VignetteValue> => {
  const bundled = (value: VignetteValue): boolean => value.element?.parent === elementId
  return [...values.filter(value => !bundled(value)), ...values.filter(bundled)]
}

/**
 * Whether a faceplate at rest is short of room: beside its controls as they stand, fewer readings than it keeps at rest
 * (or than it has) would fit. Then its controls fold behind one line too, so its readings show. Never with a proposal
 * pending, nor for one a person resized.
 */
export const shortOfRoom = (count: number, context: { readonly rest: number; readonly row: number; readonly pending: boolean; readonly rows: number | null }): boolean =>
  !context.pending && context.rows === null && shownReadings(count, context).shown < Math.min(FACEPLATE_READINGS_AT_REST, count)

/**
 * How many readings a faceplate shows, and how many give way: all, up to six, where they fit the height at rest
 * beside the rest of the card (`rest`, its height without them); else as many as fit less the row that counts the
 * others. A proposal pending, or the rows a person resized it to, override the height at rest.
 */
export const shownReadings = (count: number, context: { readonly rest: number; readonly row: number; readonly pending: boolean; readonly rows: number | null }): { readonly shown: number; readonly more: number } => {
  const fit = context.rows ?? (context.pending ? FACEPLATE_READINGS : Math.max(1, Math.floor((FACEPLATE_HEIGHT_AT_REST - context.rest) / context.row)))
  const most = Math.min(FACEPLATE_READINGS, count)
  const shown = most <= fit ? most : Math.max(1, fit - (context.rows === null ? 1 : 0))
  return { shown, more: count - shown }
}
/** The most views a vignette state holds: so many faceplates share one sample. */
export const FACEPLATES_PER_STATE = 4

/** One faceplate's readings now, or null while its sample has not come. */
export interface FaceplateReadings {
  readonly values: ReadonlyArray<VignetteValue>
  readonly observations: ReadonlyArray<Observation>
  /** The records its readings' sparklines draw (the session keeps them, kept-series.ts), and the sample's Run time. */
  readonly series: ReadonlyMap<string, DrawnSeries>
  readonly now: number
  /** The devices the element bundles (declared with it as their parent): a host lists them (W3.5). */
  readonly devices: ReadonlyArray<VignetteElement>
}

/** The states that read these elements' lead values, four elements to a state, in the elements' order. */
export const faceplateStates = (objectId: string, elements: ReadonlyArray<string>, at: string): ReadonlyArray<{ readonly elements: ReadonlyArray<string>; readonly state: string }> => {
  const unique = [...new Set(elements)]
  return Array.from({ length: Math.ceil(unique.length / FACEPLATES_PER_STATE) }, (_, chunk) => {
    const named = unique.slice(chunk * FACEPLATES_PER_STATE, (chunk + 1) * FACEPLATES_PER_STATE)
    return {
      elements: named,
      state: JSON.stringify({
        title: 'Faceplates',
        at: { at, clock: 'wall' },
        views: named.map(element => ({ kind: 'values', lead: { objectId, element }, rows: FACEPLATE_LEAD_ROWS })),
      }),
    }
  })
}

/** Each element's readings from its state's view, latest sample and kept records, by element; none before the view is read. */
export const readingsOf = (elements: ReadonlyArray<string>, view: VignetteView | undefined, sample: VignetteSample | undefined, series: ReadonlyMap<string, DrawnSeries> = new Map()): ReadonlyMap<string, FaceplateReadings> => {
  if (view === undefined || sample === undefined) return new Map()
  const now = sample.at === undefined ? Number.NaN : Date.parse(sample.at.at)
  return new Map(elements.flatMap((element, index) => {
    const section = view.sections[index]
    if (section === undefined || section.kind !== 'values') return []
    return [[element, { values: hostFirst(section.values, element).slice(0, FACEPLATE_READINGS), observations: sample.observations, series, now, devices: section.devices ?? [] }] as const]
  }))
}

/**
 * A faceplate's reading rows as the column's lead rows read (value-rows.ts, D-C): value and unit aligned, the chip
 * past a limit, the rate, and the registered 10-min sparkline where the reading has a record. Each is named by its
 * Pack's short label without its element's own name, else by its label without the display's object and that name.
 */
export const faceplateRows = (readings: FaceplateReadings, shown: number, context: { readonly title: string; readonly elementId: string; readonly frozen: boolean }): ReadonlyArray<ValueRow> => {
  const values = readings.values.slice(0, shown)
  const element = values.map(value => value.element).find(entry => entry?.id === context.elementId)
  const title = element === undefined ? context.title : `${context.title} · ${element.label}`
  return valueRows({ values, observations: readings.observations, series: readings.series, now: readings.now, title, frozen: context.frozen })
    .map((row, at) => values[at]!.shortLabel === undefined ? { ...row, label: readingLabel(values[at]!, context.title, context.elementId) } : row)
}

/** A reading's label in its element's faceplate: without the object the display is titled by, nor the element's own name. */
export const readingLabel = (value: Pick<VignetteValue, 'label' | 'element'>, title: string, elementId: string): string => {
  const shown = underTitle(value.label, title)
  const own = value.element?.id === elementId ? [value.element.shortLabel, value.element.label].filter((name): name is string => name !== undefined) : []
  const suffix = own.map(name => ` · ${name}`).find(ending => shown.endsWith(ending) && shown.length > ending.length)
  return suffix === undefined ? shown : shown.slice(0, -suffix.length)
}

/** Elements' own alerts, on one of them itself (its subject), in the sample's order. */
export const ownAlerts = (rows: ReadonlyArray<AlertRow>, objectId: string, elements: ReadonlyArray<string>): ReadonlyArray<AlertRow> =>
  rows.filter(row => row.objectId === objectId && row.alert.subject !== undefined && 'element' in row.alert.subject && elements.includes(row.alert.subject.element))
