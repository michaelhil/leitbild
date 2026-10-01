import {describe,expect,test} from 'bun:test'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {fuelHandlingChecks,parseFuelHandling} from './reference-design-fuel-handling'
const fuel:ReturnType<typeof parseFuelConstruction>={design:'LD-01-fresh-fuel-reference',assemblies:193,
 latticeSide:17,rodsPerAssembly:264,guidesPerAssembly:25,pitch_m:.0126,rodOuterDiameter_m:.0095,
 cladThickness_m:.00057,pelletDiameter_m:.0082,guideOuterDiameter_m:.0122,activeLength_m:4,
 plenumLength_m:.25,fillPressure_Pa:2e6,referenceTemperature_K:300,fuelDensityFraction:.95,
 fuelTheoreticalDensity_kg_m3:10960,cladDensity_kg_m3:6551,power_W:3e9,
 coolantPressures_MPa:[15.2,15.1,15],coolantTemperatures_K:[563.15,578.15,593.15]}
const fixture={slotRadiusSquared:61,supportRadius_m:1.85,bottomFittingLength_m:.25,bottomFitting_kg:10,
 topFittingLength_m:.15,topFitting_kg:10,guideInnerDiameter_m:.011,seatedBottom_m:-2.25,
 transferBottom_m:3.5,surface_m:14,minimumActiveCover_m:5,sourceThimbleDiameter_m:.006,
 sourceThimbleBottom_m:-3.5,sourceThimbleTop_m:2.5,sourceCapsule_m:-1,wellArea_m2:25,
 wellFloor_m:4,canalWidth_m:1,canalLength_m:6,canalFloor_m:3.5,poolSide_m:10,poolFloor_m:3.5,
 rackSide:14,rackPitch_m:.5,rackSleeveSide_m:.3,rackSkin_m:.0005,panelB10_kg_m2:.2,
 b4cDensity_kg_m3:2500,b10AtomFraction:.199,b10MolarMass_kg_mol:.010012937,b4cMolarMass_kg_mol:.055255,
 hoistForce_N:10000,hoistPower_W:5000,motionSpeed_m_s:.05,gravity_m_s2:9.80665}
const doc='```reference-fuel-handling\n'+JSON.stringify(fixture)+'\n```\n',basis=parseFuelHandling(doc)
describe('finite fuel geometry and allocation',()=>{
 test('complete envelope and source clearance, no duplicated history',()=>{
  const r=fuelHandlingChecks(basis,fuel)
  expect(r.assemblies).toBe(193);expect(r.assembly.fullLength_m).toBe(4.65)
  expect(r.assembly.transferActiveCover_m).toBe(6.25)
  expect(r.core.newBoreWater_m3).toBeGreaterThan(0)
  expect(r.core.emptyFreeWater_m3).toBeGreaterThan(r.core.fullFreeWater_m3)
  expect(r.relativeAllocationDefect).toBeLessThan(1e-13)
 })
 test('unadmitted clearance and cover cannot be accepted',()=>{
  expect(()=>fuelHandlingChecks({...basis,supportRadius_m:1.8},fuel)).toThrow('corners')
  expect(()=>fuelHandlingChecks({...basis,sourceThimbleDiameter_m:.012},fuel)).toThrow('thimble')
  expect(()=>fuelHandlingChecks({...basis,surface_m:12},fuel)).toThrow('cover')
 })
 test('strict consumed record rejects ambiguity',()=>{
  expect(()=>parseFuelHandling(doc+'\n'+doc)).toThrow()
  expect(()=>parseFuelHandling(doc.replace('"slotRadiusSquared":61','"slotRadiusSquared":62'))).toThrow()
  expect(()=>parseFuelHandling(doc.replace('"slotRadiusSquared":61','"unknown":0,"slotRadiusSquared":61'))).toThrow()
 })
})
