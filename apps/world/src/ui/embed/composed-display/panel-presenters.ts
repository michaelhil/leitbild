// Pure derivations for composed-display panels. Thresholds come from World;
// these functions only relate them to the latest sampled values.
import type { ComposedDisplayThreshold } from '../../../packs/process-plant/displays/ic-thresholds.ts'
import type { ComposedDisplayAlarm } from './composed-display-client.ts'
import { formatValue } from './trend-geometry.ts'

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

export const marginText = (margin: ThresholdMargin, unit: string): string => {
  const name = `${kindAbbreviation[margin.threshold.kind]} ${margin.threshold.value}`
  const qualified = margin.threshold.modeLabel === undefined ? '' : ` (${margin.threshold.modeLabel})`
  return margin.margin < 0 ? `beyond ${name}${qualified}` : `${formatValue(margin.margin)} ${unit} to ${name}${qualified}`.replace('  ', ' ')
}

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

export const alarmAge = (plantElapsedMs: number, firstActiveElapsedMs: number | undefined): string => {
  if (firstActiveElapsedMs === undefined) return ''
  const seconds = Math.max(0, Math.round((plantElapsedMs - firstActiveElapsedMs) / 1000))
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`
}
