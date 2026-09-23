import { expect, test } from 'bun:test'
import { noncondensableTotals } from './reference-design-pzr-noncondensables'

test('separate air and nitrogen share one caloric and pressure ledger', () => {
  const a = noncondensableTotals(0.2, 0, 500)
  const n = noncondensableTotals(0, 0.3, 500)
  const mix = noncondensableTotals(0.2, 0.3, 500)
  expect(mix.mass).toBe(0.5)
  expect(mix.mR).toBe(a.mR + n.mR)
  expect(mix.internalEnergy).toBeCloseTo(a.internalEnergy + n.internalEnergy, 8)
  expect(mix.enthalpy - mix.internalEnergy).toBeCloseTo(mix.mR * 500, 8)
  expect(a.mR / a.mass).toBe(287)
  expect(n.mR / n.mass).toBe(296.8)
})
test('zero NC requires no invented gas and invalid material is rejected', () => {
  expect(noncondensableTotals(0, 0, 500)).toEqual({ mass: 0, mR: 0, mCv: 0, internalEnergy: 0, enthalpy: 0 })
  expect(() => noncondensableTotals(-1, 0, 500)).toThrow()
  expect(() => noncondensableTotals(0, 1, 0)).toThrow()
  expect(() => noncondensableTotals(0, Number.NaN, 500)).toThrow()
})
