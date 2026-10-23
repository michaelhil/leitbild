// A values section's rows as they read in a sample (plan v5 W4.2): each its
// short label (the Pack's; else its label under the title, which gives way
// by whole words), its look, its 10-min record for the registered sparkline
// where it has a series, its rate where the 30 s and 2 min slopes agree, and
// its margin to a limit in force it is near or past. A frozen display's rows
// are doubtful and state no rate or margin: they no longer follow the Run.
import type { Observation } from '../../../core/observation/model.ts'
import type { VignetteValue } from '../../../features/displays/compose/model.ts'
import { underTitle } from './format.ts'
import { marginOf, rateText, tendencyOf, type Margin, type Written } from './margin.ts'
import { valueLook, type ReadingLook } from './readout.ts'
import type { DrawnSeries } from './trend.ts'

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
  const number = look.kind === 'number' && !look.doubtful && typeof observation?.value === 'number' && observation.quality === 'good'
  const tendency = number && series !== undefined && Number.isFinite(input.now) ? tendencyOf(series.points, input.now, series.holdMs) : null
  const written = { unit: value.unit, quantity: value.quantity, ...(value.decades === true ? { decades: true as const } : {}) }
  return {
    ref: value.ref,
    label: value.shortLabel ?? underTitle(value.label, input.title),
    full: value.label,
    look,
    series,
    recorded: value.series !== null && value.valueType !== 'criterion',
    written,
    rate: tendency === null ? null : rateText(tendency, written),
    margin: !number ? null : marginOf(observation!.value as number, value.thresholds, observation!.past, tendency ?? { short: null, long: null }, written),
  }
})

/** The margins a section's margin lines show, most urgent first (past before near, then by the scale left): at most `room`. */
export const marginLines = (rows: ReadonlyArray<ValueRow>, room: number): ReadonlyArray<ValueRow & { readonly margin: Margin }> =>
  rows.filter((row): row is ValueRow & { readonly margin: Margin } => row.margin !== null).sort((left, right) => left.margin.rank - right.margin.rank).slice(0, room)
