import { describe, expect, test } from 'bun:test'
import { parseBalanceBasis } from './reference-design-balance.ts'

const basis: ReturnType<typeof parseBalanceBasis> = {
  design: 'LD-01', reactorHeat_MW: 3000, primaryPressure_MPaAbs: 15,
  coreInlet_C: 290, coreOutlet_C: 320, steamGenerators: 2,
  secondaryPressure_MPaAbs: 6, feedInlet_C: 220,
  feedSourcePressure_MPaAbs: 0.101325, feedSource_C: 40,
  feedPumpDischarge_MPaAbs: 7.4, feedPumpHydraulicEfficiency: 0.8,
  feedPumpMotorEfficiency: 0.96, secondaryVolume_m3: 120,
  secondaryLiquidVolume_m3: 72, submergedVaporVolume_m3: 12,
  equivalentLevelArea_m2: 12, wallCapacity_MJ_K: 150,
}
const doc = (value: unknown) => '# Basis\n\n```reference-balance\n' + JSON.stringify(value) + '\n```\n'
describe('offline engineering balance inputs', () => {
  test('reads only its explicit data block', () => expect(parseBalanceBasis(doc(basis))).toEqual(basis))
  test('rejects absent or competing bases', () => {
    expect(() => parseBalanceBasis('# no basis')).toThrow()
    expect(() => parseBalanceBasis(doc(basis) + doc(basis))).toThrow()
  })
  test('rejects wrong units by unknown field, missing datum, bad physical ordering and nonfinite input', () => {
    for (const edit of [
      { primaryPressure_MPaAbs: undefined, primaryPressure_bar: 150 },
      { coreOutlet_C: 280 }, { secondaryLiquidVolume_m3: 110 },
      { feedPumpHydraulicEfficiency: 1.1 }, { reactorHeat_MW: null },
      { steamGenerators: 0 }, { feedPumpDischarge_MPaAbs: 5 },
    ]) expect(() => parseBalanceBasis(doc({ ...basis, ...edit }))).toThrow()
  })
})
