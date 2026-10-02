import { describe, expect, test } from 'bun:test'
import { fuelCaptureMultiplier } from './reference-design-fuel-capture-projection'

describe('LD-01 segment fuel capture projection, not calibrated nuclear response', () => {
  test('isothermal recovery, original table and admitted temperature endpoints', () => {
    for (const temperature_K of [290, 300, 832.642340, 1200, 2000]) {
      const value = fuelCaptureMultiplier([{ referenceFuelMass_kg: 1, temperature_K }, { referenceFuelMass_kg: 3, temperature_K }])
      expect(value.captureMultiplier).toBeCloseTo(Math.sqrt(temperature_K / 300), 14)
    }
    expect(fuelCaptureMultiplier([{ referenceFuelMass_kg: 1, temperature_K: 300 }]).captureMultiplier).toBe(1)
  })
  test('independent analytic nonuniform and unequal-mass counterexamples', () => {
    const pair = [{ referenceFuelMass_kg: 1, temperature_K: 300 }, { referenceFuelMass_kg: 1, temperature_K: 1200 }]
    expect(fuelCaptureMultiplier(pair).captureMultiplier).toBe(1.5)
    expect(fuelCaptureMultiplier(pair).captureMultiplier).not.toBe(Math.sqrt(750 / 300))
    expect(fuelCaptureMultiplier([{ ...pair[0]!, referenceFuelMass_kg: 3 }, pair[1]!]).captureMultiplier).toBe(1.25)
    expect(fuelCaptureMultiplier(pair, .5).captureMultiplier).toBe(1.25)
    expect(fuelCaptureMultiplier(pair, 0).captureMultiplier).toBe(1)
  })
  test('equal-temperature repartition and disjoint geometric incidence preserve the same reaction', () => {
    const original = [{ referenceFuelMass_kg: 1, temperature_K: 300 }, { referenceFuelMass_kg: 3, temperature_K: 1200 }]
    const split = [{ referenceFuelMass_kg: .25, temperature_K: 300 }, { referenceFuelMass_kg: .75, temperature_K: 300 }, { referenceFuelMass_kg: 1, temperature_K: 1200 }, { referenceFuelMass_kg: 2, temperature_K: 1200 }]
    const multiplier = fuelCaptureMultiplier(original).captureMultiplier
    expect(fuelCaptureMultiplier(split).captureMultiplier).toBe(multiplier)
    // Separately assembled local integral: two disjoint volumes, differing flux.
    const rates = [.2, .8].map((volume, i) => 4 * multiplier * .5 * volume * [10, 20][i]!)
    expect(rates[0]! + rates[1]!).toBeCloseTo(4 * 1.75 * .5 * (.2 * 10 + .8 * 20), 12)
    // A changed/copy-preserved pose changes incidence, not the thermal weights.
    const copy = structuredClone(original)
    expect(fuelCaptureMultiplier(copy).captureMultiplier).toBe(multiplier)
    expect(4 * multiplier * .5 * (.6 * 10 + .4 * 20)).not.toBe(rates[0]! + rates[1]!)
  })
  test('invalid/domain-exit states reject rather than clip or create a temperature', () => {
    expect(() => fuelCaptureMultiplier([])).toThrow()
    for (const temperature_K of [0, 289.9, 2000.1, NaN, Infinity])
      expect(() => fuelCaptureMultiplier([{ referenceFuelMass_kg: 1, temperature_K }])).toThrow()
    for (const referenceFuelMass_kg of [0, -1, NaN, Infinity])
      expect(() => fuelCaptureMultiplier([{ referenceFuelMass_kg, temperature_K: 300 }])).toThrow()
    for (const fD of [-.1, 1.1, NaN, Infinity])
      expect(() => fuelCaptureMultiplier([{ referenceFuelMass_kg: 1, temperature_K: 300 }], fD)).toThrow()
  })
})
