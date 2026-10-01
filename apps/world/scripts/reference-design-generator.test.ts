import { expect, test } from 'bun:test'
import { generatorArcEnergy, generatorParameters, parseGenerator } from './reference-design-generator'
const basis = { lineVoltage_V: 10000, frequency_Hz: 50, polePairs: 2, base_VA: 1100000000,
  referenceShaft_W: 1025508905.915, sizingConversion: .985, reactance_pu: 1.5,
  fieldCurrent_A: 2000, fieldCopper_W: 500000, inductanceMargin: 2, fieldDump_Ohm: 2, shaftInertia_s: 5 }
const doc = (b: unknown) => '```reference-generator\n' + JSON.stringify(b) + '\n```\n'
test('one actual generator record, positive reciprocal physical storage', () => {
  const b = parseGenerator(doc(basis)), a = generatorParameters(b)
  expect(a.speed).toBeCloseTo(1500 * 2 * Math.PI / 60, 10)
  expect(a.statorInductance * a.fieldInductance).toBeGreaterThan(a.mutual ** 2)
  expect(a.resistance).toBeGreaterThan(0)
  expect(a.fieldTime_s).toBeGreaterThan(0)
  for (const invalid of [{ ...basis, inductanceMargin: 1 }, { ...basis, lineVoltage_V: 0 }, { ...basis, captureSpeed: true }])
    expect(() => parseGenerator(doc(invalid))).toThrow()
  expect(() => parseGenerator(doc(basis) + doc(basis))).toThrow()
})
test('passive arc endpoint accounts field coupling rather than erasing magnetic energy', () => {
  expect(generatorArcEnergy(2, 1, 3, 4, 5)).toBeCloseTo(.5 * (2 - 1 / 3) * 16 + 25, 12)
  expect(generatorArcEnergy(2, 1, 3, 0, 0)).toBe(0)
  expect(() => generatorArcEnergy(1, 2, 1, 0, 0)).toThrow()
  expect(() => generatorArcEnergy(2, 1, 3, Number.NaN, 0)).toThrow()
})
