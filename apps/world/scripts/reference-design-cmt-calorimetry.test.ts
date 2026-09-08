import { expect, test } from 'bun:test'
import { parseCalorimetryBasis } from './reference-design-cmt-calorimetry.ts'

const base = { design: 'LD-01', duration_s: 60, output_s: .25, initialPressure_MPa: 15.2,
  primaryVolume_m3: 220, hot_C: 290, cold_C: 40, layers: 4,
  interlayerConductance_W_K: 1000, relativeTolerance: 1e-9, maximumStep_s: .25 }
const admitted = { minimumPressure_MPa: .1001, maximumPressure_MPa: 29, minimumTemperature_C: 20, maximumTemperature_C: 100 }
const doc = (input: unknown) => '```reference-cmt-fixture\n' + JSON.stringify(base) + '\n```\n' +
  '```reference-cmt-stratification\n{"topCells":12,"maximumStep_s":0.25}\n```\n' +
  '```reference-cmt-calorimetry\n' + JSON.stringify(input) + '\n```\n'

test('calorimetry adds a strict numeric admission band without changing source input', () => {
  const result = parseCalorimetryBasis(doc(admitted))
  expect(result.calorimetry).toEqual(admitted)
  expect(result.primaryVolume_m3).toBe(220)
  expect(result.topCells).toBe(12)
})
test('calorimetry rejects arbitrary mixing rules, invalid ordering and nonfinite values', () => {
  for (const input of [{ ...admitted, mixing: 'fit pressure' }, { ...admitted, maximumPressure_MPa: .01 },
    { ...admitted, minimumTemperature_C: 120 }, { ...admitted, minimumPressure_MPa: Infinity }])
    expect(() => parseCalorimetryBasis(doc(input))).toThrow()
})
test('calorimetry requires one unambiguous input block', () => {
  expect(() => parseCalorimetryBasis('')).toThrow()
  expect(() => parseCalorimetryBasis(doc(admitted) + '\n```reference-cmt-calorimetry\n{}\n```')).toThrow()
})
