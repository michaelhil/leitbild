import { expect, test } from 'bun:test'
import { parsePressurizerBasis } from './reference-design-pressurizer.ts'
const basis = { design: 'LD-01', volume_m3: 60, liquidVolume_m3: 30, area_m2: 5, bottomElevation_m: 2.5,
  hotPortPressure_MPa: 14.95, minimumPressure_MPa: 14, maximumPressure_MPa: 16, heatIncrement_J: 3e6 } as const
const doc = (value: unknown) => '```reference-pressurizer\n' + JSON.stringify(value) + '\n```\n'
test('PZR research has one strict selected input owner', () => expect(parsePressurizerBasis(doc(basis))).toEqual(basis))
test('PZR rejects invalid geometry, pressure bands and unknown tuning', () => {
  for (const extra of [{ volume_m3: 30 }, { liquidVolume_m3: 0 }, { area_m2: -1 },
    { minimumPressure_MPa: 15.5 }, { maximumPressure_MPa: 23 }, { heatIncrement_J: Infinity }, { pressureClamp: true }])
    expect(() => parsePressurizerBasis(doc({ ...basis, ...extra }))).toThrow()
})
test('PZR refuses absent or duplicate input', () => {
  expect(() => parsePressurizerBasis('')).toThrow()
  expect(() => parsePressurizerBasis(doc(basis) + doc(basis))).toThrow()
})
