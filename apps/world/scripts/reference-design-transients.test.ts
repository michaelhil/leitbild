import { expect, test } from 'bun:test'
import { parseTransientFixtureBasis } from './reference-design-transients.ts'

const basis: ReturnType<typeof parseTransientFixtureBasis> = {
  design: 'LD-01', gravity_m_s2: 9.80665, containmentPressure_MPaAbs: .101325,
  coldPortPressure_MPaAbs: 15.2, coldPort_C: 290, CMT_C: 40, CMTVolume_m3: 60,
  CMTBalanceRise_m: 9, CMTReferenceFlow_kg_s: 25,
  accGasPressure_MPaAbs: 5, accGasVolume_m3: 15, accWaterVolume_m3: 35, acc_C: 25,
  WSTSurface_m: 14, DVIElevation_m: 3, sumpRim_m: 4, sumpFloor_m: -2, sumpArea_m2: 200,
  recircReferenceFlow_kg_s: 60, recircLoss_Pa: 20000,
  DVIReferenceFlow_kg_s: 100, DVILoss_Pa: 10000, checkCracking_Pa: 1000,
  ADS_CdA_m2: [.0002, .0008, .0015, .006],
  RHRFlow_kg_s: 150, RHRInlet_C: 150, RHROutlet_C: 100, RHRPressure_MPaAbs: 1,
  RHRColdFlow_kg_s: 500, RHRColdInlet_C: 30,
  rotorH_s: 5, rotorBase_MW: 1100, rotor_rpm: 1500, corePower_MW: 3000,
  coreFlowArea_m2: 4.5, coreDh_m: .012, coreSurface_m2: 6000,
  decayFractions: [.01, .015, .015, .01, .01, .005],
  decayTimes_s: [1, 10, 100, 1000, 10000, 100000],
}
const doc = (value: unknown) => '# Fixture\n\n```reference-transient-fixtures\n'+JSON.stringify(value)+'\n```\n'

test('reads one explicit numerical fixture without executing wiki content', () => {
  expect(parseTransientFixtureBasis(doc(basis))).toEqual(basis)
  expect(() => parseTransientFixtureBasis('```python\nprint(1)\n```')).toThrow()
  expect(() => parseTransientFixtureBasis(doc(basis)+doc(basis))).toThrow()
  expect(() => parseTransientFixtureBasis('```reference-transient-fixtures\n{broken}\n```')).toThrow()
})

test('rejects missing, unknown, non-finite and physically unordered fixture data', () => {
  for (const edit of [
    { design: 'SM-01' }, { gravity_m_s2: undefined }, { arbitraryProgram: 'print(1)' },
    { corePower_MW: Infinity }, { CMTVolume_m3: 0 }, { DVIReferenceFlow_kg_s: -1 },
    { sumpRim_m: 3 }, { sumpFloor_m: 3 }, { RHRInlet_C: 90 }, { RHRColdInlet_C: 100 },
    { accWaterVolume_m3: 2 }, { ADS_CdA_m2: [.001] },
    { decayFractions: [1, 1, 1, 1, 1, 1] }, { decayTimes_s: [0, 1, 2, 3, 4, 5] },
  ]) expect(() => parseTransientFixtureBasis(doc({...basis, ...edit}))).toThrow()
  expect(() => parseTransientFixtureBasis(doc(basis).replace('3000', '1e999'))).toThrow()
})
