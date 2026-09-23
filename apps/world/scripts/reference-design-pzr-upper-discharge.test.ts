import { expect, test } from 'bun:test'
import { upperDischargeBasis as b, upperGeometry, upperPayload, upperReliefDemand } from './reference-design-pzr-upper-discharge'
import { advanceReliefLift } from './reference-design-rhr-local-relief'
import { sprayPhaseAreas } from './reference-design-controlled-spray-phase'

test('disjoint physical head holes and independent chambers', () => {
  const q = upperGeometry()
  expect(q.closestCenterDistance_m).toBeGreaterThan(q.closestRequiredDistance_m)
  expect(q.totalArea_m2).toBeLessThan(4.5)
  expect(q.chamberTotal_m3).toBeCloseTo(.12, 12)
  for (const area of b.stageCdA_m2) expect(area).toBeLessThan(q.adsArea_m2)
})
test('phase extinction, species and passive tracer use actual donor', () => {
  for (const a of [0, .5, 1]) {
    const q = sprayPhaseAreas(.0015, a)
    expect(q.liquid + q.gas).toBe(.0015)
  }
  const q = upperPayload(2, 3, .001, .7, .2, .1)
  expect(q.water + q.air + q.nitrogen).toBeCloseTo(5, 12)
  expect(q.tracer).toBe(.002)
  expect(upperPayload(0, 3, .001, .7, .2, .1).tracer).toBe(0)
  expect(upperPayload(2, 0, .001, 0, 0, 0).water).toBe(2)
  expect(() => upperPayload(0, 1, 0, .5, .2, .2)).toThrow()
})
test('mechanical demand is hysteretic; actual lift persists and reverses', () => {
  expect(upperReliefDemand(15.8e6, false)).toBe(true)
  expect(upperReliefDemand(15.7e6, false)).toBe(false)
  expect(upperReliefDemand(15.7e6, true)).toBe(true)
  expect(upperReliefDemand(15.6e6, true)).toBe(false)
  const lift = advanceReliefLift(0, true, .02, b.reliefStroke_s)
  expect(lift).toBeCloseTo(.4, 14)
  expect(advanceReliefLift(lift, false, .01, b.reliefStroke_s)).toBeCloseTo(.2, 14)
  expect(advanceReliefLift(lift, false, .05, b.reliefStroke_s)).toBe(0)
  expect(advanceReliefLift(0, true, .05, b.reliefStroke_s)).toBe(1)
})
