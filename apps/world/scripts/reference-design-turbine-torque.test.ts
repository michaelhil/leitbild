import { expect, test } from 'bun:test'
import { turbineIntervalTorque, turbineShaftLoads } from './reference-design-turbine-torque'

test('equivalent impulse torque is finite at stall and matches original work at its reference speed', () => {
  const drop = 100000, omega = 1500 * 2 * Math.PI / 60, eta = .85
  const radius = Math.sqrt(2 * drop) / (2 * omega)
  const stall = turbineIntervalTorque(2, drop, 0, radius, eta)
  expect(stall.torque).toBeCloseTo(2 * eta * 2 * radius * Math.sqrt(2 * drop), 8)
  expect(stall.work).toBe(0)
  expect(turbineIntervalTorque(2, drop, omega, radius, eta).work).toBeCloseTo(2 * eta * drop, 8)
  expect(turbineIntervalTorque(0, drop, omega, radius, eta).torque).toBe(0)
  expect(turbineIntervalTorque(2, 0, 0, radius, eta).torque).toBe(0)
})

test('negative work returns shaft energy to fluid without an efficiency or speed clamp', () => {
  const a = turbineIntervalTorque(2, 100000, 600, 2, .85)
  expect(a.work).toBeLessThan(0)
  const b = turbineIntervalTorque(2, 100000, -10, 2, .85)
  expect(b.work).toBeLessThan(0)
})

test('actual aerodynamic torque pays finite loss torque and rotor/oil ledger at zero and signed speed', () => {
  for (const speed of [-10, 0, 20, 157, 600]) {
    const a = turbineIntervalTorque(2, 100000, speed, 2, .85)
    const s = turbineShaftLoads(a.torque, speed, 157, .0045)
    expect(s.oilHeat).toBeGreaterThanOrEqual(0)
    expect(a.work).toBeCloseTo(s.netTorque * speed + s.oilHeat, 6)
    expect(Number.isFinite(s.netTorque)).toBe(true)
  }
})

test('unsupported inputs fail explicitly rather than becoming a zero-flow or power-floor fallback', () => {
  expect(() => turbineIntervalTorque(1, -1, 0, 1, .85)).toThrow()
  expect(() => turbineIntervalTorque(-1, 1, 0, 1, .85)).toThrow()
  expect(() => turbineIntervalTorque(1, 1, 0, 0, .85)).toThrow()
  expect(() => turbineShaftLoads(1, 0, 0, .004)).toThrow()
})
