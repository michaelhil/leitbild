import { expect, test } from 'bun:test'
import { parseCondensationMeanComparison } from './reference-design-condensation-mean.ts'
import { parseCondensationAdmission } from './reference-design-condensation-admission.ts'

test('mean comparison reuses the measured rectangles without favorable-envelope stresses', () => {
  const input: ReturnType<typeof parseCondensationAdmission> = {
    design: 'LD-01-condensation-admission', diameterStop_m: .0001,
    observedUpperVelocity_m_s: .25, pressureStress_MPa: .1, subcoolingStress_K: 2, timeAllowance_ms: 5,
    observations: (['c30', 'c50', 'd30', 'd50'] as const).map(id => ({
      id, pressure_MPa: 1.1, subcooling_K: 30, diameter_mm: [6.1, 6.8], lifetime_ms: [38, 42],
    })),
  }
  const doc = '```reference-condensation-admission\n' + JSON.stringify(input) + '\n```\n'
  const parsed = parseCondensationMeanComparison(doc)
  expect(parsed.observations).toEqual(input.observations)
  expect(parsed.relativeVelocityRange_m_s).toEqual([.2, .25])
  expect(Object.keys(parsed)).toEqual(['observations', 'relativeVelocityRange_m_s'])
  expect(() => parseCondensationMeanComparison('')).toThrow()
  expect(() => parseCondensationMeanComparison(doc + doc)).toThrow()
})
