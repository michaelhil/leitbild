// The registered sparkline (OpenBridge register `sparkline`, D-C; Q11): a
// reading's last ten minutes, step and hold for the hold served with its
// record, broken beyond it, scaled to its own range with no axes, a dot where
// it ends while its last value still holds now. It stands in for
// obc-graph-mini, which cannot break its line where nothing was recorded.
// One geometry for every site: a values row's (Sparkline.svelte) and a
// Pack's cards, which call it.
import type { SeriesPoint } from '../../../features/displays/compose/model.ts'
import { stepPath } from './trend.ts'

/** A sparkline's window: what a values row draws of its reading's record. */
export const SPARK_WINDOW_MS = 600_000

export interface Sparkline {
  readonly path: string
  /** The latest value, while it still holds now: drawn as a dot. */
  readonly end: { readonly x: number; readonly y: number } | null
  readonly range: { readonly min: number; readonly max: number }
  /** The line breaks where nothing was recorded for longer than a value holds. */
  readonly broken: boolean
}

// The line stays clear of the frame, and the dot at its end fits inside it.
const INSET_Y = 3
const INSET_END = 4
/** A scale spans at least this share of the value, and one unit for values of one or more, so a steady value reads flat, not as noise. */
const MIN_SPAN_FRACTION = 0.04
const PAD_FRACTION = 0.08

/**
 * The line over one window ending now; null where nothing recorded reaches into it. `holdMs`: how long a recorded value
 * holds until the next (the Historian's, served with the record); `silentFrom`: from when its reading measured nothing,
 * which its last value holds no further.
 */
export const sparkline = (points: ReadonlyArray<SeriesPoint>, now: number, windowMs: number, size: { readonly width: number; readonly height: number }, holdMs: number, silentFrom?: number): Sparkline | null => {
  const start = now - windowMs
  const readings = points.filter(point => Number.isFinite(point.v) && point.t <= now)
  const until = (index: number): number => Math.min(readings[index + 1]?.t ?? (silentFrom !== undefined && silentFrom >= readings[index]!.t ? silentFrom : now), readings[index]!.t + holdMs, now)
  const drawn = readings.filter((_, index) => until(index) >= start)
  if (drawn.length === 0) return null
  const range = { min: Math.min(...drawn.map(point => point.v)), max: Math.max(...drawn.map(point => point.v)) }
  const magnitude = Math.max(Math.abs(range.min), Math.abs(range.max))
  const minimum = magnitude >= 1 ? Math.max(magnitude * MIN_SPAN_FRACTION, 1) : magnitude * MIN_SPAN_FRACTION
  const middle = (range.min + range.max) / 2
  const width = range.max - range.min
  // A moving value is padded by a share of its width; one too steady to scale (a decayed power near zero) spans one unit.
  const scaled = width >= minimum ? { min: range.min - width * PAD_FRACTION, max: range.max + width * PAD_FRACTION } : { min: middle - minimum / 2, max: middle + minimum / 2 }
  const domain = scaled.max - scaled.min > 0 && Number.isFinite(scaled.max - scaled.min) ? scaled : { min: middle - 1, max: middle + 1 }
  const x = (t: number): number => ((t - start) / windowMs) * (size.width - INSET_END)
  const y = (v: number): number => INSET_Y + (1 - (v - domain.min) / (domain.max - domain.min)) * (size.height - 2 * INSET_Y)
  const last = drawn.at(-1)!
  const holding = (silentFrom === undefined || silentFrom < last.t) && last.t >= now - holdMs
  return {
    path: stepPath(drawn, x, y, { start, end: now }, holdMs, silentFrom),
    end: holding ? { x: x(now), y: y(last.v) } : null,
    range,
    broken: drawn.some((point, index) => index > 0 && point.t - drawn[index - 1]!.t > holdMs),
  }
}
