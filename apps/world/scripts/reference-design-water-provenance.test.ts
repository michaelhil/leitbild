import { expect, test } from 'bun:test'
import { checkStock, originFraction, runWaterProvenanceChecks, transferWater } from './reference-design-water-provenance'

test('water-origin conservation, phase changes, reversal, retention and refinement', () => {
  expect(runWaterProvenanceChecks().checks.length).toBeGreaterThanOrEqual(20)
})

test('invalid stock and withdrawals fail rather than clipping or relabelling', () => {
  for (const value of [-1, Infinity, NaN, 2]) expect(() => checkStock({ water_kg: 1, primaryOrigin_kg: value })).toThrow()
  expect(() => transferWater({ water_kg: 0, primaryOrigin_kg: 0 }, { water_kg: 0, primaryOrigin_kg: 0 }, 1)).toThrow()
  expect(originFraction({ water_kg: 0, primaryOrigin_kg: 0 })).toBeNull()
  expect(originFraction({ water_kg: 2, primaryOrigin_kg: 1 })).toBe(.5)
})

test('exact exhaustion and large finite parcels preserve subset endpoints without clipping', () => {
  for (const donor of [{ water_kg: .3, primaryOrigin_kg: .1 }, { water_kg: 1e200, primaryOrigin_kg: 5e199 }]) {
    const whole = transferWater(donor, { water_kg: 0, primaryOrigin_kg: 0 }, donor.water_kg)
    expect(whole.donor).toEqual({ water_kg: 0, primaryOrigin_kg: 0 })
    expect(whole.parcel.primaryOrigin_kg).toBe(donor.primaryOrigin_kg)
    const half = transferWater(donor, { water_kg: 0, primaryOrigin_kg: 0 }, donor.water_kg / 2)
    expect(half.parcel.primaryOrigin_kg).toBe(donor.primaryOrigin_kg / 2)
  }
})
