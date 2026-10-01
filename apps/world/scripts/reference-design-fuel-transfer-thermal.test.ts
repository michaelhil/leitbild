import {describe,expect,test} from 'bun:test'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling} from './reference-design-fuel-handling'
import {greyPatchExchange,parseTransferThermal,radiationAreaBudget,runTransferThermal,transferRodPatches,verifyPrimaryThermalBinding} from './reference-design-fuel-transfer-thermal'
const fuel:ReturnType<typeof parseFuelConstruction>={design:'LD-01-fresh-fuel-reference',assemblies:193,latticeSide:17,rodsPerAssembly:264,guidesPerAssembly:25,pitch_m:.0126,rodOuterDiameter_m:.0095,cladThickness_m:.00057,pelletDiameter_m:.0082,guideOuterDiameter_m:.0122,activeLength_m:4,plenumLength_m:.25,fillPressure_Pa:2e6,referenceTemperature_K:300,fuelDensityFraction:.95,fuelTheoreticalDensity_kg_m3:10960,cladDensity_kg_m3:6551,power_W:3e9,coolantPressures_MPa:[15.2,15.1,15],coolantTemperatures_K:[563.15,578.15,593.15]}
const handling:ReturnType<typeof parseFuelHandling>={slotRadiusSquared:61,supportRadius_m:1.85,bottomFittingLength_m:.25,bottomFitting_kg:10,topFittingLength_m:.15,topFitting_kg:10,guideInnerDiameter_m:.011,seatedBottom_m:-2.25,transferBottom_m:4.25,surface_m:14,minimumActiveCover_m:5,sourceThimbleDiameter_m:.006,sourceThimbleBottom_m:-3.5,sourceThimbleTop_m:2.5,sourceCapsule_m:-1,wellArea_m2:25,wellFloor_m:4,canalWidth_m:1,canalLength_m:6,canalFloor_m:3.5,poolSide_m:10,poolFloor_m:3.5,rackSide:14,rackPitch_m:.5,rackSleeveSide_m:.3,rackSkin_m:.0005,panelB10_kg_m2:.2,b4cDensity_kg_m3:2500,b10AtomFraction:.199,b10MolarMass_kg_mol:.010012937,b4cMolarMass_kg_mol:.055255,hoistForce_N:10000,hoistPower_W:5000,motionSpeed_m_s:.05,gravity_m_s2:9.80665}
const thermalRecord={primaryAxialEdges_m:[-4,-2,0,2,4],bayMeanAxialVelocity_m_s:0,fittingContactArea_m2:.1,plenumConductionFactor:2,nonfuelLiquid_h_W_m2_K:250,nonfuelGas_h_W_m2_K:5,coldPressures_Pa:[99600,101325],coldLiquidTemperatures_K:[293.15,298.15,333.15],coldWallOffsets_K:[-3,0,5],coldMaterialVelocities_m_s:[-.05,0,.05],contactFactors:[.5,1,2]},doc='```reference-fuel-transfer-thermal\n'+JSON.stringify(thermalRecord)+'\n```\n',thermal=parseTransferThermal(doc)
const area=fuel.rodsPerAssembly*Math.PI*fuel.rodOuterDiameter_m*fuel.activeLength_m/2
describe('actual FA material surface handoff',()=>{
 test('seated and interrupted material segments are not world-cell clones',()=>{
  const s=transferRodPatches(handling,fuel,thermal,{x_m:0,y_m:0,bottom_m:-2.25},[14,14,14])
  expect(s[0]!.areas_m2['PRIMARY.CORE1']).toBeCloseTo(area,10);expect(s[1]!.areas_m2['PRIMARY.CORE2']).toBeCloseTo(area,10)
  const p=transferRodPatches(handling,fuel,thermal,{x_m:0,y_m:0,bottom_m:-.25},[14,14,14])
  expect(p[0]!.areas_m2['PRIMARY.CORE2']).toBeCloseTo(area,10);expect(p[1]!.areas_m2['PRIMARY.UPPER']).toBeCloseTo(area,10)
 })
 test('real surface splits across both transverse gate planes',()=>{
  for(const [x,a,b] of [[2.5,'WELL.LIQUID','CANAL.LIQUID'],[8.5,'CANAL.LIQUID','POOL.LIQUID']] as const){
   const patches=transferRodPatches(handling,fuel,thermal,{x_m:x,y_m:0,bottom_m:4.25},[14,14,14])
   for(const p of patches){expect(p.areas_m2[a]).toBeCloseTo(area/2,10);expect(p.areas_m2[b]).toBeCloseTo(area/2,10)}
  }
 })
 test('partial cover and racked below-flange material keep actual recipient',()=>{
  const p=transferRodPatches(handling,fuel,thermal,{x_m:13.5,y_m:0,bottom_m:4.25},[14,14,7.5])
  expect(p[0]!.areas_m2['POOL.LIQUID']).toBeCloseTo(area,10);expect(p[1]!.areas_m2['POOL.LIQUID']).toBeCloseTo(area/2,10);expect(p[1]!.areas_m2['CNV.GAS']).toBeCloseTo(area/2,10)
  const r=transferRodPatches(handling,fuel,thermal,{x_m:13.5,y_m:0,bottom_m:3.5},[14,14,14])
  expect(r[0]!.areas_m2['POOL.LIQUID']).toBeCloseTo(area,10);expect(r[0]!.areas_m2['PRIMARY.UPPER']).toBeUndefined()
 })
 test('unsupported and absent view are not fabricated heat recipients',()=>{
  const p=transferRodPatches(handling,fuel,thermal,{x_m:25,y_m:0,bottom_m:4.25},[14,14,14]);expect(p[0]!.areas_m2.UNADMITTED).toBeCloseTo(area,10)
  expect(()=>transferRodPatches(handling,fuel,thermal,{x_m:0,y_m:0,bottom_m:NaN},[14,14,14])).toThrow()
  expect(()=>transferRodPatches(handling,fuel,thermal,{x_m:0,y_m:0,bottom_m:4.25},[14,14,3])).toThrow()
  const r=radiationAreaBudget([.1,.1,.01],.001);expect(r.reduce((s,q)=>s+q.exchange_m2,0)).toBeCloseTo(.001,15);expect(r.reduce((s,q)=>s+q.recipient_m2,0)).toBeCloseTo(.001,15)
  expect(radiationAreaBudget([.1,0],0)).toEqual([{exchange_m2:0,recipient_m2:0},{exchange_m2:0,recipient_m2:0}]);expect(()=>radiationAreaBudget([NaN],1)).toThrow()
  expect(()=>radiationAreaBudget([Number.MAX_VALUE,Number.MAX_VALUE],1)).toThrow()
  const q=greyPatchExchange(.1,.001,.001,.7,.7,333.15,300);expect(q.recipient_W).toBeGreaterThan(0);expect(q.source_W+q.recipient_W).toBe(0)
  expect(greyPatchExchange(.1,.001,.001,.7,.7,290,300).recipient_W).toBeLessThan(0);expect(greyPatchExchange(0,0,0,.7,.7,333.15,300).recipient_W).toBe(0)
 })
 test('strict selected record and actual primary binding',()=>{
  expect(()=>parseTransferThermal(doc+doc)).toThrow();expect(()=>parseTransferThermal(doc.replace('"bayMeanAxialVelocity_m_s":0','"bayMeanAxialVelocity_m_s":1'))).toThrow()
  const table='| Lower plenum | 28.5 m³, −4 to −2 m |\n| Core.1 / Core.2 | Each 9.359063 m³; −2…0 and 0…+2 m |\n| Upper plenum | 33.5 m³, +2 to +4 m |'
  expect(verifyPrimaryThermalBinding(table,thermal)).toEqual([-4,-2,-2,0,0,2,2,4]);expect(()=>verifyPrimaryThermalBinding(table.replace('+4 m','+5 m'),thermal)).toThrow()
 })
 const wiki=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON
 if(Boolean(wiki)!==Boolean(python))throw Error('Native thermal check requires both LEITBILD_REFERENCE_WIKI and LEITBILD_REFERENCE_PYTHON')
 test.skipIf(!wiki||!python)('actual selected native cold sensible/He/contact points',async()=>{
  const r=await runTransferThermal(wiki!,python!);expect(r.rows.length).toBe(162);expect(r.contactRows.length).toBe(27)
  expect(r.rows.some((q:{p_Pa:number})=>q.p_Pa<1e5)).toBe(true);expect(r.rows.every((q:{wallVapor_kg_s:number})=>q.wallVapor_kg_s===0)).toBe(true)
  expect(r.rows.some((q:{segmentHeat_W:number})=>q.segmentHeat_W<0)).toBe(true);expect(r.rows.some((q:{segmentHeat_W:number})=>q.segmentHeat_W>0)).toBe(true)
  expect(r.contactRows.every((q:{plenum_h_W_m2_K:number})=>q.plenum_h_W_m2_K>0)).toBe(true)
  expect(r.radiationBudget.reduce((s:number,q:{exchange_m2:number})=>s+q.exchange_m2,0)).toBeCloseTo(r.radiationInput.recipientArea_m2,15)
  expect(r.radiationHeat.every((q:{source_W:number,recipient_W:number})=>q.source_W+q.recipient_W===0)).toBe(true)
 },30000)
})
