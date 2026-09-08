import { describe, expect, test } from 'bun:test'
import { parseCondensationAdmission } from './reference-design-condensation-admission.ts'
import { parseCondensationMobileComparison } from './reference-design-condensation-mobile.ts'

const fixture: ReturnType<typeof parseCondensationAdmission> = {
  design: 'LD-01-condensation-admission', diameterStop_m: .0001,
  observedUpperVelocity_m_s: .25, pressureStress_MPa: .1,
  subcoolingStress_K: 2, timeAllowance_ms: 5,
  observations: [
    { id: 'c30', pressure_MPa: .4, subcooling_K: 30, diameter_mm: [10, 10.5], lifetime_ms: [31, 34] },
    { id: 'c50', pressure_MPa: .4, subcooling_K: 50, diameter_mm: [9.4, 10], lifetime_ms: [16, 19] },
    { id: 'd30', pressure_MPa: 1.1, subcooling_K: 30, diameter_mm: [6.1, 6.8], lifetime_ms: [38, 42] },
    { id: 'd50', pressure_MPa: 1.1, subcooling_K: 50, diameter_mm: [7.3, 8], lifetime_ms: [19, 23] },
  ],
}
const document = (value: unknown) => '```reference-condensation-admission\n' + JSON.stringify(value) + '\n```'

describe('mobile-interface comparison input', () => {
  test('shares frozen observations without carrying old favorable-screen allowances', () => {
    const result = parseCondensationMobileComparison(document(fixture))
    expect(result.observations).toEqual(fixture.observations)
    expect(result.relativeVelocityRange_m_s).toEqual([.2, .25])
    expect(Object.keys(result).sort()).toEqual(['observations', 'relativeVelocityRange_m_s'])
  })
  test('does not silently repair malformed or duplicate evidence', () => {
    expect(() => parseCondensationMobileComparison('')).toThrow()
    expect(() => parseCondensationMobileComparison(document({ ...fixture,
      observations: fixture.observations.map(x => ({ ...x, id: 'c30' })),
    }))).toThrow()
    expect(() => parseCondensationMobileComparison(document({ ...fixture,
      observations: fixture.observations.map(x => ({ ...x, diameter_mm: [10, 9] })),
    }))).toThrow()
  })
})
