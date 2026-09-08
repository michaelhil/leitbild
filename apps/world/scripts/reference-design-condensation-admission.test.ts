import { expect, test } from 'bun:test'
import { parseCondensationAdmission } from './reference-design-condensation-admission.ts'

const basis: ReturnType<typeof parseCondensationAdmission> = {
  design: 'LD-01-condensation-admission', diameterStop_m: .0001,
  observedUpperVelocity_m_s: .25, pressureStress_MPa: .1, subcoolingStress_K: 2, timeAllowance_ms: 5,
  observations: [
    { id: 'c30', pressure_MPa: .4, subcooling_K: 30, diameter_mm: [10, 10.5], lifetime_ms: [31, 34] },
    { id: 'c50', pressure_MPa: .4, subcooling_K: 50, diameter_mm: [9.4, 10], lifetime_ms: [16, 19] },
    { id: 'd30', pressure_MPa: 1.1, subcooling_K: 30, diameter_mm: [6.1, 6.8], lifetime_ms: [38, 42] },
    { id: 'd50', pressure_MPa: 1.1, subcooling_K: 50, diameter_mm: [7.3, 8], lifetime_ms: [19, 23] },
  ],
}
const doc = (x: unknown) => '```reference-condensation-admission\n' + JSON.stringify(x) + '\n```\n'
test('admission comparison keeps source rectangles and stress assumptions explicit', () => {
  expect(parseCondensationAdmission(doc(basis))).toEqual(basis)
  expect(() => parseCondensationAdmission('')).toThrow()
  expect(() => parseCondensationAdmission(doc(basis) + doc(basis))).toThrow()
  expect(() => parseCondensationAdmission(doc({ ...basis, unknown: true }))).toThrow()
  expect(() => parseCondensationAdmission(doc({ ...basis, observedUpperVelocity_m_s: 1 }))).toThrow()
  expect(() => parseCondensationAdmission(doc({ ...basis, observations: basis.observations.slice(1) }))).toThrow()
  for (const change of [{ id: 'c50' }, { diameter_mm: [10, 9] }, { pressure_MPa: .1 },
    { lifetime_ms: [NaN, 34] }, { subcooling_K: 1 }, { diameter_mm: [.01, .02] }]) {
    const observations = [{ ...basis.observations[0], ...change }, ...basis.observations.slice(1)]
    expect(() => parseCondensationAdmission(doc({ ...basis, observations }))).toThrow()
  }
})
