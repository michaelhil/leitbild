import { describe, expect, test } from 'bun:test'
import { shortName } from '../src/ui/embed/composed-display/pen-style.ts'
import { activeThreshold, agoText, alarmAge, limitAhead, returningText, median, minutesToThreshold, movingAwayFromLimits, rateChange, ratePerMinute, rateText, rateWindowMs, timeToThresholdText, visibleAlarms, annunciatorStates } from '../src/ui/embed/composed-display/panel-presenters.ts'
import { formatQuantity, marginText, nearestThresholdMargin, simulationClock, thresholdName, unitLabel } from '../src/packs/process-plant/displays/display-text.ts'
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
    expect(thresholdName(thresholds[0]!, 'MPa', { withUnit: false })).toBe('LO TRIP 20')
    expect(nearestThresholdMargin(10, [thresholds[2]!])).toBeNull()
  })

  test('fractions read as percent wherever the display or the answer names them', () => {
    const busLow = { ruleId: 'bus-low', label: 'Bus voltage low', kind: 'alarm', operator: '<', direction: 'low', value: 0.9 } as const
    expect(formatQuantity(1, 'fraction')).toBe('100 %')
    expect(formatQuantity(0.955, 'fraction')).toBe('95.5 %')
    expect(formatQuantity(0, 'kg/s')).toBe('0 kg/s')
    expect(formatQuantity(125, 'volts_dc')).toBe('125 V DC')
    expect(unitLabel('degC/s')).toBe('°C/s')
    expect(thresholdName(busLow, 'fraction')).toBe('LO ALM 90 %')
    expect(marginText(nearestThresholdMargin(0.955, [busLow])!, 'fraction')).toBe('LO ALM 90 % · 5.50 above')
    expect(rateText(-0.012, 0.955, 'fraction')).toBe('▼ −1.20 %/min')
    expect(unitLabel('fraction')).toBe('%')
  })

  test('the limit ahead follows the direction of travel, also while in alarm', () => {
    // SG B in LO ALM 30, falling: the next limit is LO TRIP 20, not the alarm it has passed.
    expect(limitAhead(28, -2.25, thresholds)?.threshold.ruleId).toBe('trip-low')
    // Rising away from the low limits toward HI ALM 75.
    expect(limitAhead(60, 24, thresholds)?.threshold.ruleId).toBe('alarm-high')
    // Rising with no high limit configured: none ahead, and the legend says so.
    const lowOnly = thresholds.filter(threshold => threshold.direction === 'low')
    expect(limitAhead(72, 24, lowOnly)).toBeNull()
    expect(movingAwayFromLimits(72, 24, lowOnly)).toBe('rising')
    // Steady: the nearest limit either way.
    expect(limitAhead(34.5, 0, thresholds)?.threshold.ruleId).toBe('alarm-low')
    expect(movingAwayFromLimits(34.5, 0, thresholds)).toBeNull()
  })

  test('a value in alarm that is moving back says when it will be back inside the limit', () => {
    // SG A N-16 in HI ALM 5 mSv/h and drifting down.
    const highRadiation = { ruleId: 'n16-high', label: 'Secondary radiation high', kind: 'alarm', operator: '>', direction: 'high', value: 5 } as const
    expect(returningText(5.4, -0.2, highRadiation, 'mSv/h')).toBe('back below HI ALM 5 mSv/h · ≈2 min')
    expect(returningText(5.4, 0.2, highRadiation, 'mSv/h')).toBe('')
  })

  test('long names are shortened from the middle so the equipment survives', () => {
    expect(shortName('Process valve position · Feedwater Control Valve B', 30)).toBe('Process valve…Control Valve B')
    expect(shortName('PT-455', 30)).toBe('PT-455')
  })

  test('median of parallel signals', () => {
    expect(median([4250, 4250, 3100, 4250])).toBe(4250)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  test('alarms read first-out first, then trips, then by severity, then active before cleared, then by onset', () => {
    const alarms: ReadonlyArray<ComposedDisplayAlarm> = [
      { id: 'a', ruleId: 'sg-b-level-low', kind: 'alarm', title: 'SG B level low', severity: 'warning', active: true, acknowledged: true, firstOut: false, firstActiveElapsedMs: 100_000 },
      { id: 'b', ruleId: 'sg-b-level-low-low', kind: 'trip', title: 'SG B low-low', severity: 'critical', active: true, acknowledged: false, firstOut: true, firstActiveElapsedMs: 200_000 },
      { id: 'c', ruleId: 'other', kind: 'alarm', title: 'Other', severity: 'critical', active: true, acknowledged: false, firstOut: false },
      { id: 'd', ruleId: 'sg-b-feedwater-low', kind: 'alarm', title: 'SG B feed low', severity: 'warning', active: true, acknowledged: false, firstOut: false, firstActiveElapsedMs: 50_000 },
    ]
    expect(visibleAlarms(alarms, 'related', ['sg-b-level-low', 'sg-b-level-low-low', 'sg-b-feedwater-low']).map(alarm => alarm.id)).toEqual(['b', 'd', 'a'])
    const plant: ReadonlyArray<ComposedDisplayAlarm> = [
      { id: 'cleared', ruleId: 'r1', kind: 'alarm', title: 'Cleared', severity: 'critical', active: false, acknowledged: false, firstOut: false, firstActiveElapsedMs: 1_000 },
      { id: 'critical', ruleId: 'r2', kind: 'alarm', title: 'Critical', severity: 'critical', active: true, acknowledged: true, firstOut: false, firstActiveElapsedMs: 2_000 },
      { id: 'trip', ruleId: 'r3', kind: 'trip', title: 'Trip', severity: 'warning', active: true, acknowledged: true, firstOut: false, firstActiveElapsedMs: 3_000 },
    ]
    expect(visibleAlarms(plant, 'plant', []).map(alarm => alarm.id)).toEqual(['trip', 'critical', 'cleared'])
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
    const rate = ratePerMinute(falling, 60_000)!
    expect(rate).toBeCloseTo(-1.8, 6)
    expect(rateText(rate, 38.2, '%')).toBe('▼ −1.80 %/min')
    expect(rateText(rate, 38.2, '%', { windowMs: 15_000, change: 'slowing' })).toBe('▼ −1.80 %/min · 15 s · slowing')
    expect(rateText(0.0001, 38.2, '%')).toBe('► steady')
    expect(rateText(0.0001, 38.2, '%', { windowMs: 15_000 })).toBe('► steady · 15 s')
    expect(ratePerMinute([{ t: 0, v: 1 }, { t: 5_000, v: 2 }], 60_000)).toBeNull()
    // A window the data covers only partly gives no rate rather than a short-span guess.
    expect(ratePerMinute(falling.slice(0, 31), 60_000)).toBeNull()
    expect(minutesToThreshold(38.2, rate, thresholds[1]!)).toBeCloseTo(4.56, 2)
    expect(minutesToThreshold(38.2, 1.8, thresholds[1]!)).toBeNull()
  })

  test('rates follow the curve on screen and say when it is slowing', () => {
    expect([120_000, 600_000, 1_800_000].map(rateWindowMs)).toEqual([10_000, 30_000, 30_000])
    // Falling fast for a minute, then nearly flat for the last 15 s.
    const flattening = Array.from({ length: 76 }, (_, index) => ({ t: index * 1000, v: index <= 60 ? 15 - index * 0.05 : 12 - (index - 60) * 0.002 }))
    const window = rateWindowMs(120_000)
    expect(Math.abs(ratePerMinute(flattening, window)!)).toBeLessThan(0.3)
    expect(rateChange(flattening, window, 12)).toBe('slowing')
    const steadyFall = Array.from({ length: 76 }, (_, index) => ({ t: index * 1000, v: 15 - index * 0.05 }))
    expect(rateChange(steadyFall, window, 12)).toBeNull()
    expect(simulationClock(Date.parse('2026-01-01T10:01:00.049Z'))).toBe('10:01:00')
    // Rising 0.31 MPa/min with 0.285 MPa left to HI ALM 16 (turbine trip, run 6).
    const highAlarm = { ruleId: 'pzr-high', label: 'Pressurizer pressure high', kind: 'alarm', operator: '>', direction: 'high', value: 16 } as const
    expect(timeToThresholdText(15.715, 0.31, highAlarm)).toBe('≈55 s')
    expect(timeToThresholdText(15.715, -0.31, highAlarm)).toBe('')
    expect(timeToThresholdText(10, 0.1, highAlarm)).toBe('')
    expect(unitLabel('degC')).toBe('°C')
  })

  test('the most severe active threshold marks the value', () => {
    expect(activeThreshold(thresholds, new Set(['alarm-low', 'trip-low']))?.ruleId).toBe('trip-low')
    expect(activeThreshold(thresholds, new Set(['control']))).toBeNull()
  })
})

describe('annunciator tiles', () => {
  const alarm = (ruleId: string, severity: ComposedDisplayAlarm['severity'], extra: Partial<ComposedDisplayAlarm> = {}): ComposedDisplayAlarm => ({
    id: `${ruleId}:a`, ruleId, kind: 'alarm', title: ruleId, severity, active: true, acknowledged: true, firstOut: false, ...extra,
  })

  test('each declared system counts its own active alarms, says how severe the worst is, and whether any trip or is unacknowledged', () => {
    const systems = [{ name: 'steam generators', ruleIds: ['sg-a-low', 'sg-b-low'] }, { name: 'electrical', ruleIds: ['bus-a-dead'] }, { name: 'containment', ruleIds: ['ctmt-high'] }]
    const states = annunciatorStates(systems, [
      alarm('sg-a-low', 'warning'),
      alarm('sg-b-low', 'critical', { acknowledged: false }),
      alarm('bus-a-dead', 'notice', { kind: 'trip', firstOut: true }),
      alarm('not-annunciated', 'critical'),
      // Cleared but unacknowledged: listed, not counted as active.
      alarm('ctmt-high', 'critical', { active: false, acknowledged: false }),
    ])
    expect(states).toEqual([
      { name: 'steam generators', active: 2, unacknowledged: 1, severity: 'critical', trip: false, firstOut: false },
      { name: 'electrical', active: 1, unacknowledged: 0, severity: 'notice', trip: true, firstOut: true },
      // A quiet system keeps its place.
      { name: 'containment', active: 0, unacknowledged: 0, severity: null, trip: false, firstOut: false },
    ])
  })
})
