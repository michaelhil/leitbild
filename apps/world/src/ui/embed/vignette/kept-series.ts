// What a vignette keeps of the records it draws (plan v5 W8.5): each trend
// pen's over its trend's window and each values row's over its sparkline's,
// read once with a sample (on open, after a gap, or for a row that appears
// when its lead changes, such as after a trip), then extended by every sample
// from its reading, so no sample reads a record again. A reading that is bad
// or outside its declared validity measures nothing: the trace breaks there,
// its last value held no further than the sample, until it measures again.
import type { RecordedSeries, VignetteSample, VignetteView } from '../../../features/displays/compose/model.ts'
import { SPARK_WINDOW_MS } from './sparkline.ts'
import { appendPoint, type DrawnSeries } from './trend.ts'

/** A record a view draws: its ref, its series and the widest window it is drawn over. */
export interface ShownSeries { readonly ref: string; readonly seriesId: string; readonly horizonMs: number }

/** Every record a view draws now: its trend pens' and its values rows' (where their reading has a series), each once at its widest window. */
export const shownSeries = (view: VignetteView): ReadonlyArray<ShownSeries> => {
  const shown = new Map<string, ShownSeries>()
  const add = (ref: string, seriesId: string, horizonMs: number): void => {
    const known = shown.get(ref)
    if (known === undefined || known.horizonMs < horizonMs) shown.set(ref, { ref, seriesId, horizonMs })
  }
  for (const section of view.sections) {
    if (section.kind === 'trend') for (const pen of section.strips.flat()) { if (pen.series !== null) add(pen.ref, pen.series.seriesId, section.horizonMs) }
    if (section.kind === 'values') for (const value of section.values) { if (value.series !== null && value.valueType !== 'criterion') add(value.ref, value.series.seriesId, SPARK_WINDOW_MS) }
  }
  return [...shown.values()]
}

/** The widest window a view draws a record over; 0 where it draws none. */
export const widestWindow = (shown: ReadonlyArray<ShownSeries>): number => Math.max(0, ...shown.map(entry => entry.horizonMs))

/** The refs a view draws whose record is not kept: read with the next sample. */
export const unkept = (shown: ReadonlyArray<ShownSeries>, kept: ReadonlyMap<string, DrawnSeries>): ReadonlyArray<string> =>
  shown.filter(entry => !kept.has(entry.ref)).map(entry => entry.ref)

/**
 * The records kept after a sample: those it served (by series id) replace what was kept of them; every other one shown
 * is extended by the sample's reading; one no longer shown is dropped. `fresh`: the sample served every record shown
 * (on open, after a gap or a reset): nothing kept before it is kept.
 */
export const keptAfter = (kept: ReadonlyMap<string, DrawnSeries>, shown: ReadonlyArray<ShownSeries>, sample: VignetteSample, fresh: boolean): ReadonlyMap<string, DrawnSeries> => {
  const at = Date.parse(sample.at.at)
  const served: Readonly<Record<string, RecordedSeries>> = sample.series ?? {}
  const next = new Map<string, DrawnSeries>()
  for (const entry of shown) {
    const recorded: DrawnSeries | undefined = served[entry.seriesId] ?? (fresh ? undefined : kept.get(entry.ref))
    // A record that was not served draws nothing: its hold comes with its record, never guessed.
    if (recorded === undefined) continue
    const observation = sample.observations.find(reading => reading.ref === entry.ref)
    const value = observation?.quality === 'bad' || observation?.quality === 'not-applicable' ? undefined : observation?.value
    // A state's band reads on as 1, off as 0, as its record does (display-capabilities.ts).
    next.set(entry.ref, typeof value === 'number' || typeof value === 'boolean' ? { holdMs: recorded.holdMs, points: appendPoint(recorded.points, { t: at, v: Number(value) }, at - entry.horizonMs) }
      : { ...recorded, silentFrom: recorded.silentFrom ?? at })
  }
  return next
}
