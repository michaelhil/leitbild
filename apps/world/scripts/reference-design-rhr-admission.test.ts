import { describe, expect, test } from 'bun:test'
import { parseRhrAdmissionBasis } from './reference-design-rhr-admission'

const fixture: ReturnType<typeof parseRhrAdmissionBasis> = {
  primaryVolume_m3: 220.718126, headerVolume_m3: 2, trainVolume_m3: 4,
  primaryElevation_m: 2.5, receiverElevation_m: -2, dviElevation_m: 3,
  referencePressure_MPa: 1, referenceTemperature_C: 150,
  normalPressure_MPa: 1, normalTemperature_C: 150, faultPressure_MPa: 15.2, faultTemperature_C: 290,
  receiverPressure_MPa: 0.3, receiverTemperature_C: 40,
  commonReferenceFlow_kg_s: 300, commonLosses_Pa: [10000, 20000, 20000],
  fillCdA_m2: 0.00002, reliefCdA_m2: 0.0005, reliefOpen_MPa: 1.3, reliefReseat_MPa: 1.2,
  envelope_MPa: 2, containmentPressure_MPa: 0.101325, valveStroke_s: 2, normalDuration_s: 20,
}
const document = (b: unknown) => '```reference-rhr-admission\n' + JSON.stringify(b) + '\n```\n'

describe('finite RHR admission input boundary', () => {
  test('accepts the explicit finite fixture without a sibling wiki checkout', () => {
    expect(parseRhrAdmissionBasis(document(fixture))).toEqual(fixture)
    expect(() => parseRhrAdmissionBasis(document(fixture) + document(fixture))).toThrow()
  })
  test('rejects invented defaults, nonfinite capacity and invalid pressure/datum ordering', () => {
    expect(() => parseRhrAdmissionBasis(document({ ...fixture, reliefCdA_m2: 0 }))).toThrow()
    expect(() => parseRhrAdmissionBasis(document({ ...fixture, envelope_MPa: 1.2 }))).toThrow()
    expect(() => parseRhrAdmissionBasis(document({ ...fixture, primaryVolume_m3: null }))).toThrow()
    expect(() => parseRhrAdmissionBasis(document({ ...fixture, hiddenReliefDelay: 0 }))).toThrow()
    expect(() => parseRhrAdmissionBasis(document({ ...fixture, dviElevation_m: -3 }))).toThrow()
  })
})
