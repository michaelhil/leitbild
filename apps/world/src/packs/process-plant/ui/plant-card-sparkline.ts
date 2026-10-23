import type { SimulationRunId } from '../../../core/model/index.ts'
import { workspaceApiPath } from '../../../ui/workspace-context.ts'
import { displayValue, formatQuantity, formatValue } from '../quantity-text.ts'
import { sparkline as drawnSparkline, type Sparkline } from '../../../ui/sparkline.ts'

// A Plant card's energy lines: the Run's recorded points of a rate, how a
// line extends with the projection's readings, and the sparkline it draws,
// step and hold with no axes, which way the rate is going at a glance. Time
// is Simulation Run time in epoch milliseconds; values are the rate's unit.

export interface TrendPoint {
  readonly t: number
  readonly v: number
}

/** The operations Historian re-records an unchanged value at most once a minute: a held value is drawn across gaps up to this, and broken beyond. */
export const HOLD_GAP_MS = 90_000
/** One page of the Run's history: a ten-minute line at a second's interval with room to spare. */
const HISTORY_LIMIT = 4_000

/** Keeps points ordered and drops those that can no longer reach into a window starting at `windowStart`. */
export const appendPoint = (points: ReadonlyArray<TrendPoint>, point: TrendPoint, windowStart: number): ReadonlyArray<TrendPoint> =>
  [...points.filter(existing => existing.t >= windowStart - HOLD_GAP_MS && existing.t < point.t), point]

/** What the Run's historian recorded of a series in a window of Run time: its numeric samples, oldest first. */
export const readHistory = async (runId: SimulationRunId, seriesId: string, window: { readonly from: number; readonly to: number }): Promise<ReadonlyArray<TrendPoint>> => {
  const query = new URLSearchParams({ mode: 'raw', seriesId, timeAxis: 'simulation', from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString(), limit: String(HISTORY_LIMIT) })
  const response = await fetch(`${workspaceApiPath(`/simulation-runs/${encodeURIComponent(runId)}/history/samples`)}?${query}`)
  if (!response.ok) throw new Error(`Reading history failed with HTTP ${response.status}`)
  const page = await response.json() as { readonly samples?: ReadonlyArray<{ readonly simulationTime?: string; readonly value: unknown }> }
  return (page.samples ?? []).flatMap(sample => typeof sample.value === 'number' && sample.simulationTime !== undefined ? [{ t: Date.parse(sample.simulationTime), v: sample.value }] : [])
    .sort((left, right) => left.t - right.t)
}

export type { Sparkline } from '../../../ui/sparkline.ts'

/** The registered sparkline (World's one geometry, ui/sparkline.ts) over one window ending now, a value held across the Historian's hold; null where nothing recorded reaches into it. */
export const sparkline = (points: ReadonlyArray<TrendPoint>, now: number, windowMs: number, size: { readonly width: number; readonly height: number }): Sparkline | null =>
  drawnSparkline(points, now, windowMs, size, HOLD_GAP_MS)

/** What a line shows, for its tooltip and accessible name: it has no value axis, so the words carry the range. */
export const sparklineText = (line: Sparkline, windowMs: number, unit: string): string => {
  const spread = line.range.min === line.range.max ? `steady at ${formatQuantity(line.range.min, unit, null)}`
    : `${formatValue(displayValue(line.range.min, unit), null)} to ${formatQuantity(line.range.max, unit, null)}`
  return `Last ${Math.round(windowMs / 60_000)} min: ${spread}${line.broken ? ' · broken where nothing was recorded' : ''}`
}
