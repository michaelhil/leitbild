// A values section's rows as they read in a sample (plan v5 W4.2): each its
// short label (the Pack's; else its label under the title, which gives way
// by whole words), its look, its 10-min record for the registered sparkline
// where it has a series, its rate where the 30 s and 2 min slopes agree, and
// its margin to a limit in force it is near or past. A frozen display's rows
// are doubtful and state no rate or margin: they no longer follow the Run.
import { numberStep, type Observation } from '../../../core/observation/model.ts'
import type { VignetteValue, VignetteView } from '../../../features/displays/compose/model.ts'
import { underTitle } from './format.ts'
import { marginOf, tendencyOf, type Margin, type Written } from './margin.ts'
import { valueLook, type ReadingLook } from './readout.ts'
import { rateText, type DrawnSeries } from './trend.ts'

export interface ValueRow {
  readonly ref: string
  /** What the row names it by: its short label, else its label under the vignette's title. */
  readonly label: string
  /** Its whole label, for the title and assistive technology. */
  readonly full: string
  readonly look: ReadingLook
  /** Its record, where its observable has a series: the row draws a sparkline. */
  readonly series: DrawnSeries | undefined
  readonly recorded: boolean
  /** How its numbers are written (its unit code, quantity and decades). */
  readonly written: Written
  readonly rate: string | null
  readonly margin: Margin | null
  /**
   * Where it has no record to draw (W4.2, W9.3: no sparkline without history), a level, a loading or a position whose
   * Pack declares its instrument's span: a span bar, its ends the span's, a tick at each alarm and trip limit in it.
   */
  readonly bar: SpanBar | null
}

export interface SpanBar { readonly min: number; readonly max: number; readonly value: number; readonly ticks: ReadonlyArray<number> }

/** The quantities a span bar reads well for: a fill of a known span. */
const SPANNED: ReadonlySet<VignetteValue['quantity']> = new Set(['level', 'loading'])

/** A value's span bar (SpanBar), or null: recorded values draw their sparkline instead. */
export const spanBar = (value: Pick<VignetteValue, 'span' | 'quantity' | 'travel' | 'thresholds'>, reading: number, recorded: boolean): SpanBar | null => {
  const span = value.span
  if (recorded || span === undefined || !(SPANNED.has(value.quantity) || value.travel !== undefined)) return null
  return {
    min: span.min, max: span.max, value: Math.min(span.max, Math.max(span.min, reading)),
    ticks: [...new Set(value.thresholds.filter(threshold => (threshold.effect === 'alarm' || threshold.effect === 'trip') && threshold.value > span.min && threshold.value < span.max).map(threshold => threshold.value))],
  }
}

/**
 * What a row names a value by: its short label, without its element's short name in that element's own detail ("Unit
 * B pressure" reads "Pressure" under the title "… · Unit B"); else its label under the title.
 */
export const ownLabel = (value: Pick<VignetteValue, 'shortLabel' | 'label' | 'element'>, title: string, subject?: VignetteView['subject']): string => {
  const short = value.shortLabel
  const element = value.element
  // In its element's own detail, or in an answer about that one element (its subject, W7.3).
  const own = element !== undefined && (title.endsWith(` · ${element.label}`) || subject?.element === (element.shortLabel ?? element.label))
  if (short === undefined) {
    // Without a short label, its label under the title, its element's name dropped in that element's own detail ("State").
    const label = underTitle(value.label, title, subject)
    const suffix = element === undefined ? undefined : ` · ${element.shortLabel ?? element.label}`
    return own && suffix !== undefined && label.endsWith(suffix) && label.length > suffix.length ? label.slice(0, -suffix.length) : label
  }
  const prefix = element?.shortLabel === undefined ? undefined : `${element.shortLabel} `
  if (element === undefined || prefix === undefined || !own || !short.toLowerCase().startsWith(prefix.toLowerCase()) || short.length === prefix.length) return short
  const rest = short.slice(prefix.length)
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
}

export const valueRows = (input: {
  readonly values: ReadonlyArray<VignetteValue>
  readonly observations: ReadonlyArray<Observation>
  readonly series: ReadonlyMap<string, DrawnSeries>
  /** The latest sample's Run time. */
  readonly now: number
  readonly title: string
  /** The one object (and element) the vignette is about, which a label drops (W7.3). */
  readonly subject?: VignetteView['subject']
  readonly frozen: boolean
}): ReadonlyArray<ValueRow> => input.values.map(value => {
  const observation = input.observations.find(entry => entry.ref === value.ref)
  const read = valueLook(value, input.observations, value.ref)
  const look: ReadingLook = input.frozen ? { ...read, doubtful: true } : read
  const series = input.series.get(value.ref)
  // A rate and a margin are read off a value in its span: never off a pinned end, nor off a wider range standing in.
  const number = look.kind === 'number' && !look.doubtful && look.offSpan === null && typeof observation?.value === 'number' && observation.quality === 'good'
  const tendency = number && series !== undefined && Number.isFinite(input.now) ? tendencyOf(series.points, input.now, series.holdMs, numberStep(observation!.value as number, value.unit, value.quantity)) : null
  const written = { unit: value.unit, quantity: value.quantity, ...(value.decades === true ? { decades: true as const } : {}) }
  const recorded = value.series !== null && (value.valueType === 'number' || value.valueType === 'duration')
  return {
    ref: value.ref,
    label: ownLabel(value, input.title, input.subject),
    full: value.label,
    look,
    series,
    recorded,
    written,
    rate: tendency?.rate === null || tendency === null ? null : rateText(tendency.rate, value.unit, value.quantity),
    margin: !number ? null : marginOf(observation!.value as number, value.thresholds, observation!.past, tendency ?? { short: null, long: null, rate: null }, { ...written, ...(value.span === undefined ? {} : { span: value.span }) }),
    bar: look.kind === 'number' && typeof observation?.value === 'number' && (observation.quality === 'good' || observation.quality === 'uncertain' || observation.quality === 'stale') ? spanBar(value, observation.value, recorded) : null,
  }
})

/** The margins a section's margin lines show, most urgent first (past before near, then by the scale left): at most `room`. */
export const marginLines = (rows: ReadonlyArray<ValueRow>, room: number): ReadonlyArray<ValueRow & { readonly margin: Margin }> =>
  rows.filter((row): row is ValueRow & { readonly margin: Margin } => row.margin !== null).sort((left, right) => left.margin.rank - right.margin.rank).slice(0, room)
