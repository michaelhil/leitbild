import { expect, test } from 'bun:test'
import { parseCycleBasis } from './reference-design-cycle.ts'

const basis: ReturnType<typeof parseCycleBasis> = {
  design: 'LD-01', reactorHeat_MW: 3000, steamGenerators: 2,
  coreInletPressure_MPaAbs: 15.2, coreMidPressure_MPaAbs: 15.1, coreOutletPressure_MPaAbs: 15,
  coreInlet_C: 290, coreMid_C: 305, coreOutlet_C: 320,
  RCPSuctionPressure_MPaAbs: 14.7, RCPDischargePressure_MPaAbs: 15.3,
  RCPHydraulicEfficiency: .85, RCPMotorEfficiency: .96, RCPDragFraction: .01,
  steamPressure_MPaAbs: 6, feedInlet_C: 220, feedPumpDischarge_MPaAbs: 7.4,
  feedHeaderPressure_MPaAbs: 7.2, feedSourcePressure_MPaAbs: .101325,
  feedPumpHydraulicEfficiency: .8, feedPumpMotorEfficiency: .96, feedPumpDragFraction: .01,
  condensate_C: 40, condensatePumpHydraulicEfficiency: .8, condensatePumpMotorEfficiency: .95,
  highBleedPressure_MPaAbs: 4, separatorPressure_MPaAbs: .8,
  lowBleedPressure_MPaAbs: .2, lowestBleedPressure_MPaAbs: .05,
  heaterOutlet_C: [70,110,155], reheatOutlet_C: 260,
  HPTurbineEfficiency: .85, LPTurbineEfficiency: .88,
  shaftMechanicalEfficiency: .995, generatorEfficiency: .985,
}
const doc = (value: unknown) => '# Selected input\n\n```reference-cycle\n'+JSON.stringify(value)+'\n```\n'
test('selects explicit whole-cycle data, not arbitrary executable wiki text', () => {
  expect(parseCycleBasis(doc(basis))).toEqual(basis)
  expect(() => parseCycleBasis('```python\nprint(1)\n```')).toThrow()
  expect(() => parseCycleBasis(doc(basis)+doc(basis))).toThrow()
})
test('rejects incomplete data, mismatched units and contradictory ordered states', () => {
  for(const edit of [
    { reactorHeat_MW: undefined }, { steamPressure_MPaAbs: undefined, steamPressure_bar: 60 },
    { coreMid_C: 330 }, { highBleedPressure_MPaAbs: 7 },
    { RCPDischargePressure_MPaAbs: 15.1 }, { heaterOutlet_C: [70,160,110] },
    { generatorEfficiency: 1.01 }, { feedHeaderPressure_MPaAbs: 5 },
    { RCPDragFraction: -1 }, { steamGenerators: 4 },
  ]) expect(() => parseCycleBasis(doc({...basis,...edit}))).toThrow()
})
