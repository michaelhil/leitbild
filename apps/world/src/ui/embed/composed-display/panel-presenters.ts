// Pure derivations for composed-display panels. Thresholds come from World;
// these functions only relate them to the latest sampled values.
import { thresholdName } from '../../../packs/process-plant/displays/display-text.ts'
import type { ComposedDisplayThreshold } from '../../../packs/process-plant/displays/ic-thresholds.ts'
import type { ComposedDisplayAlarm } from './composed-display-client.ts'
import { formatValue, type TrendPoint } from './trend-geometry.ts'

export interface ThresholdMargin {
  readonly threshold: ComposedDisplayThreshold
  /** Distance before the rule acts; negative once the value is beyond it. */
  readonly margin: number
}

/** The alarm or trip threshold the value is closest to acting on. */
export const nearestThresholdMargin = (
  value: number,
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
): ThresholdMargin | null => {
  const margins = thresholds
    .filter(threshold => threshold.kind !== 'control')
    .map(threshold => ({
      threshold,
      margin: threshold.operator === '<' || threshold.operator === '<=' ? value - threshold.value : threshold.value - value,
    }))
  if (margins.length === 0) return null
  return margins.reduce((nearest, candidate) => candidate.margin < nearest.margin ? candidate : nearest)
}

export const marginText = (margin: ThresholdMargin, unit: string): string => {
  const name = thresholdName(margin.threshold, unit)
  const qualified = margin.threshold.modeLabel === undefined ? '' : ` (${margin.threshold.modeLabel})`
  if (margin.margin < 0) return `past ${name}${qualified}`
  return `${name}${qualified} · ${formatValue(margin.margin)} ${margin.threshold.direction === 'low' ? 'above' : 'below'}`
}

// A rate needs some history: two points at least this far apart.
const RATE_MIN_SPAN_MS = 10_000

/**
 * The window a rate is measured over: an eighth of the trend horizon, so the
 * number follows the curve the operator sees (2 min horizon: 15 s), between
 * 10 s for 1 s samples and one minute.
 */
export const rateWindowMs = (horizonMs: number): number =>
  Math.min(60_000, Math.max(RATE_MIN_SPAN_MS, Math.round(horizonMs / 8 / 5_000) * 5_000))

/** Least-squares slope over the window, per minute; null unless the data spans most of it. */
export const ratePerMinute = (points: ReadonlyArray<TrendPoint>, windowMs: number): number | null => {
  const last = points.at(-1)
  if (last === undefined) return null
  const recent = points.filter(point => point.t >= last.t - windowMs)
  if (recent.length < 2 || last.t - recent[0]!.t < Math.max(RATE_MIN_SPAN_MS, windowMs * 0.75)) return null
  const meanT = recent.reduce((sum, point) => sum + point.t, 0) / recent.length
  const meanV = recent.reduce((sum, point) => sum + point.v, 0) / recent.length
  const covariance = recent.reduce((sum, point) => sum + (point.t - meanT) * (point.v - meanV), 0)
  const variance = recent.reduce((sum, point) => sum + (point.t - meanT) ** 2, 0)
  return variance === 0 ? null : (covariance / variance) * 60_000
}

// A change below 0.1 % of the value per minute reads as steady.
const isSteady = (rate: number, value: number): boolean => Math.abs(rate) <= Math.abs(value) * 0.001

export type RateChange = 'accelerating' | 'slowing' | 'reversing'

/**
 * How the rate over the window compares with the rate over four windows, so a
 * curve that has flattened is not reported only by its older, steeper slope.
 */
export const rateChange = (points: ReadonlyArray<TrendPoint>, windowMs: number, value: number): RateChange | null => {
  const recent = ratePerMinute(points, windowMs)
  const longer = ratePerMinute(points, windowMs * 4)
  if (recent === null || longer === null || isSteady(longer, value)) return null
  if (!isSteady(recent, value) && Math.sign(recent) !== Math.sign(longer)) return 'reversing'
  if (Math.abs(recent) < Math.abs(longer) * 0.5) return 'slowing'
  if (Math.abs(recent) > Math.abs(longer) * 1.5) return 'accelerating'
  return null
}

export const windowText = (windowMs: number): string => `${Math.round(windowMs / 1000)} s`

/** "▼ −1.80 %/min · 15 s · slowing"; the window and change only when given. */
export const rateText = (
  rate: number | null,
  value: number,
  unit: string,
  detail: { readonly windowMs?: number; readonly change?: RateChange | null } = {},
): string => {
  if (rate === null) return ''
  const window = detail.windowMs === undefined ? '' : ` · ${windowText(detail.windowMs)}`
  if (isSteady(rate, value)) return `► steady${window}`
  const change = detail.change === undefined || detail.change === null ? '' : ` · ${detail.change}`
  return `${rate > 0 ? '▲ +' : '▼ −'}${formatValue(Math.abs(rate))} ${unit}/min${window}${change}`
}

/** Minutes until the value reaches the threshold at the current rate, if moving toward it. */
export const minutesToThreshold = (value: number, rate: number | null, threshold: ComposedDisplayThreshold): number | null => {
  if (rate === null || rate === 0) return null
  const distance = threshold.value - value
  if (Math.sign(distance) !== Math.sign(rate)) return null
  const already = threshold.direction === 'low' ? value <= threshold.value : value >= threshold.value
  return already ? null : distance / rate
}

export const agoText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

/** The most severe of a signal's thresholds whose I&C rule is active now. */
export const activeThreshold = (
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
  activeRuleIds: ReadonlySet<string>,
): ComposedDisplayThreshold | null =>
  thresholds.filter(threshold => threshold.kind !== 'control' && activeRuleIds.has(threshold.ruleId))
    .sort((left, right) => Number(right.kind === 'trip') - Number(left.kind === 'trip'))[0] ?? null

export const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const

/**
 * Alarms in reading order: trips before alarms, then severity, unacknowledged
 * first, newest first. "related" keeps only the rules acting on the display.
 */
export const visibleAlarms = (
  alarms: ReadonlyArray<ComposedDisplayAlarm>,
  scope: 'related' | 'plant',
  ruleIds: ReadonlyArray<string>,
): ReadonlyArray<ComposedDisplayAlarm> => {
  const related = new Set(ruleIds)
  return alarms
    .filter(alarm => scope === 'plant' || related.has(alarm.ruleId))
    .sort((left, right) =>
      Number(left.kind !== 'trip') - Number(right.kind !== 'trip')
      || severityRank[left.severity] - severityRank[right.severity]
      || Number(left.acknowledged) - Number(right.acknowledged)
      || (right.firstActiveElapsedMs ?? 0) - (left.firstActiveElapsedMs ?? 0))
}

/** Age as m:ss under an hour, otherwise h:mm, so onset order is readable at a glance. */
export const alarmAge = (plantElapsedMs: number, firstActiveElapsedMs: number | undefined): string => {
  if (firstActiveElapsedMs === undefined) return ''
  const seconds = Math.max(0, Math.round((plantElapsedMs - firstActiveElapsedMs) / 1000))
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`
}

/** Simulation time of day as the display header shows it: "10:01:00". */
export const simulationClock = (ms: number): string => new Date(ms).toISOString().slice(11, 19)
