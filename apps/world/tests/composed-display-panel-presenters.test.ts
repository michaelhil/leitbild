import { describe, expect, test } from 'bun:test'
import { activeThreshold, agoText, alarmAge, marginText, median, minutesToThreshold, nearestThresholdMargin, ratePerMinute, rateText, thresholdName, visibleAlarms } from '../src/ui/embed/composed-display/panel-presenters.ts'
import type { ComposedDisplayThreshold } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import type { ComposedDisplayAlarm } from '../src/ui/embed/composed-display/composed-display-client.ts'

const thresholds: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'trip-low', label: 'Low-low', kind: 'trip', operator: '<', direction: 'low', value: 20 },
  { ruleId: 'alarm-low', label: 'Low', kind: 'alarm', operator: '<', direction: 'low', value: 30 },
  { ruleId: 'control', label: 'Demand', kind: 'control', operator: '<', direction: 'low', value: 50 },
  { ruleId: 'alarm-high', label: 'High', kind: 'alarm', operator: '>', direction: 'high', value: 75, modeLabel: 'power operation' },
]

describe('composed display panel presenters', () => {
  test('margin to the nearest acting alarm or trip threshold, ignoring control set points', () => {
    const near = nearestThresholdMargin(34.5, thresholds)!
    expect([near.threshold.ruleId, near.margin]).toEqual(['alarm-low', 4.5])
    expect(marginText(near, '%')).toBe('LO ALM 30 % · 4.50 above')
    const beyond = nearestThresholdMargin(26.9, thresholds)!
    expect(marginText(beyond, '%')).toBe('past LO ALM 30 %')
    expect(marginText(nearestThresholdMargin(70, thresholds)!, '%')).toBe('HI ALM 75 % (power operation) · 5.00 below')
    expect(thresholdName(thresholds[0]!, 'MPa')).toBe('LO TRIP 20 MPa')
    expect(nearestThresholdMargin(10, [thresholds[2]!])).toBeNull()
  })

  test('median of parallel signals', () => {
    expect(median([4250, 4250, 3100, 4250])).toBe(4250)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  test('alarms read trips first, then severity, unacknowledged and newest', () => {
    const alarms: ReadonlyArray<ComposedDisplayAlarm> = [
      { id: 'a', ruleId: 'sg-b-level-low', kind: 'alarm', title: 'SG B level low', severity: 'warning', acknowledged: true, firstOut: false, firstActiveElapsedMs: 100_000 },
      { id: 'b', ruleId: 'sg-b-level-low-low', kind: 'trip', title: 'SG B low-low', severity: 'critical', acknowledged: false, firstOut: true, firstActiveElapsedMs: 200_000 },
      { id: 'c', ruleId: 'other', kind: 'alarm', title: 'Other', severity: 'critical', acknowledged: false, firstOut: false },
      { id: 'd', ruleId: 'sg-b-feedwater-low', kind: 'alarm', title: 'SG B feed low', severity: 'warning', acknowledged: false, firstOut: false, firstActiveElapsedMs: 50_000 },
    ]
    expect(visibleAlarms(alarms, 'related', ['sg-b-level-low', 'sg-b-level-low-low', 'sg-b-feedwater-low']).map(alarm => alarm.id)).toEqual(['b', 'd', 'a'])
    expect(visibleAlarms(alarms, 'plant', []).map(alarm => alarm.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  test('alarm age in Plant time', () => {
    expect(alarmAge(130_000, 100_000)).toBe('0:30')
    expect(alarmAge(700_000, 100_000)).toBe('10:00')
    expect(alarmAge(4_000_000, 100_000)).toBe('1 h 05')
    expect(alarmAge(700_000, undefined)).toBe('')
    expect(agoText(23_400)).toBe('23 s ago')
    expect(agoText(250_000)).toBe('4 min ago')
  })

  test('rate, direction and time to threshold at the current rate', () => {
    const falling = Array.from({ length: 61 }, (_, index) => ({ t: index * 1000, v: 40 - index * 0.03 }))
    const rate = ratePerMinute(falling)!
    expect(rate).toBeCloseTo(-1.8, 6)
    expect(rateText(rate, 38.2, '%')).toBe('▼ −1.80 %/min')
    expect(rateText(0.0001, 38.2, '%')).toBe('► steady')
    expect(ratePerMinute([{ t: 0, v: 1 }, { t: 5_000, v: 2 }])).toBeNull()
    expect(minutesToThreshold(38.2, rate, thresholds[1]!)).toBeCloseTo(4.56, 2)
    expect(minutesToThreshold(38.2, 1.8, thresholds[1]!)).toBeNull()
  })

  test('the most severe active threshold marks the value', () => {
    expect(activeThreshold(thresholds, new Set(['alarm-low', 'trip-low']))?.ruleId).toBe('trip-low')
    expect(activeThreshold(thresholds, new Set(['control']))).toBeNull()
  })
})
