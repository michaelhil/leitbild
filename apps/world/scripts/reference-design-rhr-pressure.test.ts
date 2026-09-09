import { expect, test } from 'bun:test'
import { parseRhrPressureBasis } from './reference-design-rhr-pressure'

const basis: ReturnType<typeof parseRhrPressureBasis> = {
  referencePressure_MPa: 1, referenceTemperature_C: 150, pumpReferenceTotal_kg_s: 165,
  pumpReferenceRise_MPa: .5, minimumFlowReference_kg_s: 15, minimumFlowReferenceDrop_MPa: .5,
  sourcePressure_MPa: 1.5, dischargeEnvelope_MPa: 2, sourceElevation_m: 2.5, pumpElevation_m: -2,
  selectedEntrySource_MPa: 1.15, headerTrip_MPa: 1.25, headerReliefOpen_MPa: 1.30, headerReliefReseat_MPa: 1.20,
  temperatures_C: [40, 100, 150, 160, 180],
}
const document = (b: unknown) => '```reference-rhr-pressure\n' + JSON.stringify(b) + '\n```'
test('RHR pressure screen consumes its strict owning basis', () => {
  expect(parseRhrPressureBasis(document(basis))).toEqual(basis)
  expect(() => parseRhrPressureBasis(document({ ...basis, unowned: 1 }))).toThrow()
  expect(() => parseRhrPressureBasis(document(basis) + '\n' + document(basis))).toThrow()
})
test('RHR screen rejects wrong control-plane and flow/temperature domain', () => {
  expect(() => parseRhrPressureBasis(document({ ...basis, pumpElevation_m: 3 }))).toThrow()
  expect(() => parseRhrPressureBasis(document({ ...basis, minimumFlowReference_kg_s: 170 }))).toThrow()
  expect(() => parseRhrPressureBasis(document({ ...basis, temperatures_C: [40, 200] }))).toThrow()
})
