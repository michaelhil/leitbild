import { describe, expect, test } from 'bun:test'
import { parseCondensationPlume } from './reference-design-condensation-plume.ts'

const fixture: ReturnType<typeof parseCondensationPlume> = {
  design: 'LD-01-condensation-plume', imageScale_mm_px: .32,
  cases: [
    { id: 'SCUBA-18', sourceNozzle: 'CIN4mm', liquidTemperature_C: 98, subcooling_K: 7,
      effectiveDiameter_mm: 24, steamVelocity_m_s: 1.62, waterSuperficialVelocity_m_s: .6,
      nuCoefficient: .055, nuExponent: .93, peakPixel: [337, 352],
      readings: [{ pixel: [271, 284], normalizedOccupancy: [.48, .52] }] },
    { id: 'SCUBA-72', sourceNozzle: 'HIN2X4mm', liquidTemperature_C: 98, subcooling_K: 7.3,
      effectiveDiameter_mm: 13, steamVelocity_m_s: 1.1, waterSuperficialVelocity_m_s: .6,
      nuCoefficient: .2753, nuExponent: .75, peakPixel: [451, 468],
      readings: [{ pixel: [344, 360], normalizedOccupancy: [.48, .52] }] },
  ],
}
const doc = (input: unknown) => '```reference-condensation-plume\n' + JSON.stringify(input) + '\n```'

describe('prescribed-flow ensemble evidence', () => {
  test('preserves source geometry, motion, coefficients and independent image coordinates', () => {
    expect(parseCondensationPlume(doc(fixture))).toEqual(fixture)
  })
  test('rejects absent/duplicate records, nonpositive slip and incorrectly oriented images', () => {
    expect(() => parseCondensationPlume('')).toThrow()
    expect(() => parseCondensationPlume(doc(fixture) + '\n' + doc(fixture))).toThrow()
    expect(() => parseCondensationPlume(doc({ ...fixture, cases: [fixture.cases[0], fixture.cases[0]] }))).toThrow()
    expect(() => parseCondensationPlume(doc({ ...fixture,
      cases: fixture.cases.map(c => ({ ...c, steamVelocity_m_s: .5 })),
    }))).toThrow()
    expect(() => parseCondensationPlume(doc({ ...fixture,
      cases: fixture.cases.map(c => ({ ...c, peakPixel: [100, 200] })),
    }))).toThrow()
    expect(() => parseCondensationPlume(doc({ ...fixture,
      cases: fixture.cases.map(c => ({ ...c, readings: [{ pixel: [271, 284], normalizedOccupancy: [.9, 1.1] }] })),
    }))).toThrow()
  })
})
