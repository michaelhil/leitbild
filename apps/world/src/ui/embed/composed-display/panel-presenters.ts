// Pure derivations for composed-display panels. Thresholds come from World;
// these functions only relate them to the latest sampled values.
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

const kindAbbreviation = { trip: 'TRIP', alarm: 'ALM', control: 'CTL' } as const

/** Operator name of a threshold, with direction, kind, exact value and unit: "LO ALM 30 %". */
export const thresholdName = (threshold: ComposedDisplayThreshold, unit: string): string =>
  `${threshold.direction === 'low' ? 'LO' : 'HI'} ${kindAbbreviation[threshold.kind]} ${threshold.value}${unit === '' ? '' : ` ${unit}`}`

export const marginText = (margin: ThresholdMargin, unit: string): string => {
  const name = thresholdName(margin.threshold, unit)
  const qualified = margin.threshold.modeLabel === undefined ? '' : ` (${margin.threshold.modeLabel})`
  if (margin.margin < 0) return `past ${name}${qualified}`
  return `${name}${qualified} · ${formatValue(margin.margin)} ${margin.threshold.direction === 'low' ? 'above' : 'below'}`
}

// A rate needs some history: two points at least this far apart.
const RATE_MIN_SPAN_MS = 10_000

/** Least-squares slope over the last minute, per minute; null without enough data. */
export const ratePerMinute = (points: ReadonlyArray<TrendPoint>, windowMs = 60_000): number | null => {
  const last = points.at(-1)
  if (last === undefined) return null
  const recent = points.filter(point => point.t >= last.t - windowMs)
  if (recent.length < 2 || last.t - recent[0]!.t < RATE_MIN_SPAN_MS) return null
  const meanT = recent.reduce((sum, point) => sum + point.t, 0) / recent.length
  const meanV = recent.reduce((sum, point) => sum + point.v, 0) / recent.length
  const covariance = recent.reduce((sum, point) => sum + (point.t - meanT) * (point.v - meanV), 0)
  const variance = recent.reduce((sum, point) => sum + (point.t - meanT) ** 2, 0)
  return variance === 0 ? null : (covariance / variance) * 60_000
}

/** "▲ +1.80 %/min"; steady when the minute's change is below 0.1 % of the value. */
export const rateText = (rate: number | null, value: number, unit: string): string => {
  if (rate === null) return ''
  if (Math.abs(rate) <= Math.abs(value) * 0.001) return '► steady'
  return `${rate > 0 ? '▲ +' : '▼ −'}${formatValue(Math.abs(rate))} ${unit}/min`
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
