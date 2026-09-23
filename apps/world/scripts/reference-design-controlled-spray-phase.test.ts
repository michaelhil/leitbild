import { expect, test } from 'bun:test'
import { sprayPhaseAreas, sprayCheckArea, sprayJetThrust } from './reference-design-controlled-spray-phase'

test('tube surface allocation preserves real area through phase loss', () => {
  for (const fraction of [0, 0.3, 1]) {
    const a = sprayPhaseAreas(2, fraction)
    expect(a.liquid + a.gas).toBe(2)
    expect(a.liquid).toBe(2 * fraction)
  }
  expect(() => sprayPhaseAreas(2, -0.1)).toThrow()
})
test('actual inlet check permits forward and failed-open reverse only', () => {
  expect(sprayCheckArea(0.001, true, false)).toBe(0.001)
  expect(sprayCheckArea(0.001, false, false)).toBe(0)
  expect(sprayCheckArea(0.001, false, true)).toBe(0.001)
  expect(sprayCheckArea(0, true, true)).toBe(0)
  expect(() => sprayCheckArea(-1, true, false)).toThrow()
})
test('blocked tips give hardware pressure load, not a zero-mass jet', () => {
  expect(sprayJetThrust(0, 0, 7e6, 3e5, 0)).toEqual({ momentum: 0, pressure: 0 })
  expect(() => sprayJetThrust(1, 10, 7e6, 3e5, 0)).toThrow()
  expect(sprayJetThrust(2, 10, 7e6, 3e5, 0.001)).toEqual({ momentum: 20, pressure: 6700 })
  expect(sprayJetThrust(2, 10, 3e5, 3e5, 0.001).pressure).toBe(0)
})
