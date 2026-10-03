import { expect, test } from 'bun:test'
import { freeMoment, ventReceiver } from './reference-design-primary-receiver-joins'

test('actual free moment changes with submerged translation without changing volume', () => {
  const a = freeMoment(33.5, 100.5, [{ volume: .085, center: 2.5 }])
  const b = freeMoment(33.5, 100.5, [{ volume: .085, center: 2.8 }])
  expect(a.volume).toBe(b.volume)
  expect(b.moment - a.moment).toBeCloseTo(-.085 * .3, 12)
  expect(a.center).toBeGreaterThan(3)
  expect(b.center).toBeLessThan(a.center)
  expect(() => freeMoment(1, 0, [{ volume: 1, center: 0 }])).toThrow()
})

test('RHR vent dry, equality and submerged reverse donors are distinct', () => {
  expect(ventReceiver(false, -2, 101325, 1000)).toEqual({ donor: 'CNV', pressure: 101325 })
  expect(ventReceiver(true, -2, 101325, 1000)).toEqual({ donor: 'CNV', pressure: 101325 })
  expect(ventReceiver(true, -1, 101325, 1000)).toEqual({ donor: 'SUMP', pressure: 111131.65 })
  expect(ventReceiver(true, 4, 200000, 1000).pressure).toBeCloseTo(258839.9, 8)
})
