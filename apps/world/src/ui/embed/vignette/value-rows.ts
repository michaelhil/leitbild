// A values section's rows as they read in a sample (plan v5 W4.2): each its
// short label (the Pack's; else its label under the title, which gives way
// by whole words), its look, its 10-min record for the registered sparkline
// where it has a series, its rate where the 30 s and 2 min slopes agree, and
// its margin to a limit in force it is near or past. A frozen display's rows
// are doubtful and state no rate or margin: they no longer follow the Run.
import { numberStep, type Observation } from '../../../core/observation/model.ts'
import type { VignetteValue } from '../../../features/displays/compose/model.ts'
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
}

/**
 * What a row names a value by: its short label, without its element's short name in that element's own detail ("SG A
 * narrow-range level" reads "Narrow-range level" under the title "… · Steam Generator A"); else its label under the title.
 */
export const ownLabel = (value: Pick<VignetteValue, 'shortLabel' | 'label' | 'element'>, title: string): string => {
  const short = value.shortLabel
  if (short === undefined) return underTitle(value.label, title)
  const element = value.element
  const prefix = element?.shortLabel === undefined ? undefined : `${element.shortLabel} `
  if (element === undefined || prefix === undefined || !title.endsWith(` · ${element.label}`) || !short.toLowerCase().startsWith(prefix.toLowerCase()) || short.length === prefix.length) return short
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
  return {
    ref: value.ref,
    label: ownLabel(value, input.title),
    full: value.label,
    look,
    series,
    recorded: value.series !== null && (value.valueType === 'number' || value.valueType === 'duration'),
    written,
    rate: tendency?.rate === null || tendency === null ? null : rateText(tendency.rate, value.unit, value.quantity),
    margin: !number ? null : marginOf(observation!.value as number, value.thresholds, observation!.past, tendency ?? { short: null, long: null, rate: null }, written),
  }
})

/** The margins a section's margin lines show, most urgent first (past before near, then by the scale left): at most `room`. */
export const marginLines = (rows: ReadonlyArray<ValueRow>, room: number): ReadonlyArray<ValueRow & { readonly margin: Margin }> =>
  rows.filter((row): row is ValueRow & { readonly margin: Margin } => row.margin !== null).sort((left, right) => left.margin.rank - right.margin.rank).slice(0, room)
