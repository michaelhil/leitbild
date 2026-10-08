import { describe, expect, test } from 'bun:test'
import { alarmAge, marginText, median, nearestThresholdMargin, visibleAlarms } from '../src/ui/embed/composed-display/panel-presenters.ts'
import type { ComposedDisplayThreshold } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import type { ComposedDisplayAlarm } from '../src/ui/embed/composed-display/composed-display-client.ts'

const thresholds: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'trip-low', label: 'Low-low', kind: 'trip', operator: '<', value: 20 },
  { ruleId: 'alarm-low', label: 'Low', kind: 'alarm', operator: '<', value: 30 },
  { ruleId: 'control', label: 'Demand', kind: 'control', operator: '<', value: 50 },
  { ruleId: 'alarm-high', label: 'High', kind: 'alarm', operator: '>', value: 75, modeLabel: 'power operation' },
]

describe('composed display panel presenters', () => {
  test('margin to the nearest acting alarm or trip threshold, ignoring control set points', () => {
    const near = nearestThresholdMargin(34.5, thresholds)!
    expect([near.threshold.ruleId, near.margin]).toEqual(['alarm-low', 4.5])
    expect(marginText(near, '%')).toBe('4.50 % to ALM 30')
    const beyond = nearestThresholdMargin(26.9, thresholds)!
    expect(marginText(beyond, '%')).toBe('beyond ALM 30')
    expect(marginText(nearestThresholdMargin(70, thresholds)!, '%')).toBe('5.00 % to ALM 75 (power operation)')
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
    expect(alarmAge(130_000, 100_000)).toBe('30 s')
    expect(alarmAge(700_000, 100_000)).toBe('10 min')
    expect(alarmAge(700_000, undefined)).toBe('')
  })
})
