import { expect, test } from 'bun:test'
import { calculateStation, isolatedRHRFlow, parseStationBasis, pumpDuty } from './reference-design-station.ts'

// Deliberately synthetic closed cycle for arithmetic tests; not LD-01 evidence.
const cycle={powers_MW:{core:3000,gross_electric:980,condenser:2030.2,
  turbine_thermodynamic_work:1000,RCP_electric:18,RCP_fluid:16,
  feed_pump_electric:15,feed_pump_fluid:14,condensate_pump_electric:.25,condensate_pump_fluid:.2}}
const basis={design:'LD-01',alignment:'full-power-RHR-isolated',waterDensity_kg_m3:1000,waterCp_J_kgK:4180,
  siteWater_C:20,ambient_C:25,condenserOnlyRise_K:10,
  CW:{head_MPa:.3,hydraulicEfficiency:.85,motorEfficiency:.96,dragFraction:0},
  CCW:{head_MPa:.3,hydraulicEfficiency:.8,motorEfficiency:.94,dragFraction:0,ratedFlow_kg_s:600,auxiliaryBranchReference_kg_s:100,supply_C:30},
  SW:{head_MPa:.3,hydraulicEfficiency:.8,motorEfficiency:.94,dragFraction:.01,flowA_kg_s:2000,flowB_kg_s:3000},
  shaftMechanicalEfficiency:.995,dcLoadA_kW:8,dcLoadB_kW:5,converterEfficiency:.92,
  fanEach_kW:20,transformerFixed_kW:20,transformerLoadFraction:.01,busEach_MW:40,source_MW:90,
  roomAirEach_kg_s:20,airCp_J_kgK:1005,roomWallEach_MW_K:.02,
  CWmotorEach_MW_K:.02,serviceMotorEach_MW_K:.002,transformerEach_MW_K:.02}
const doc=(value:unknown)=>'```reference-station\n'+JSON.stringify(value)+'\n```\n'

test('CCW isolated branch satisfies pump and resistance, not the rated flow',()=>{
  const r=isolatedRHRFlow(600,100)
  expect(r.flow_kg_s).toBeCloseTo(111.41720290623111,10)
  expect(r.headRatio).toBeCloseTo(1.25-.25*(r.flow_kg_s/600)**2,12)
  expect(isolatedRHRFlow(600,600).flow_kg_s).toBeCloseTo(600,10)
  for(const pair of [[0,100],[600,0],[600,700],[NaN,100]])expect(()=>isolatedRHRFlow(pair[0]!,pair[1]!)).toThrow()
})
test('pump energy pays hydraulic inefficiency and drag exactly once',()=>{
  const r=pumpDuty(1000,.4,1000,.8,.9,.01)
  expect(r.hydraulic_MW).toBe(.4)
  expect(r.fluid_MW).toBe(.5)
  expect(r.electric_MW).toBeCloseTo(.505/.9,12)
  expect(r.fluid_MW+r.motorAndDrag_MW).toBe(r.electric_MW)
  expect(pumpDuty(0,.4,1000,.8,.9,.01).electric_MW).toBe(0)
  expect(()=>pumpDuty(1,.4,1000,1.1,.9,0)).toThrow()
})
test('station first law closes all named heat paths and reserve import',()=>{
  const b=parseStationBasis(doc(basis)),r=calculateStation(b,cycle),p=r.powers_MW
  expect(Math.abs(p.residual)).toBeLessThan(1e-9)
  expect(p.netExport).toBeCloseTo(980-p.busA-p.busB-p.unitConversionLoss-.02,10)
  expect(r.temperatures_C.CW_discharge).toBeGreaterThan(30)
  expect(p.CCW_B_heat).toBeGreaterThan(p.CCW_A_heat)
  // Unequal DC loading affects the correct bus and room, not every division.
  const changed=calculateStation({...b,dcLoadA_kW:9},cycle)
  expect(changed.powers_MW.busA-p.busA).toBeCloseTo(.001/.92,12)
  expect(changed.powers_MW.busB).toBe(p.busB)
  expect(changed.temperatures_C.roomB).toBe(r.temperatures_C.roomB)
  expect(()=>calculateStation(b,{powers_MW:{...cycle.powers_MW,condenser:2031}})).toThrow('first-law')
})
test('station input is strict data and rejects contradictory selections',()=>{
  expect(parseStationBasis(doc(basis)).alignment).toBe('full-power-RHR-isolated')
  for(const edit of [{alignment:'shutdown'},{CW:{...basis.CW,head_MPa:-1}},
    {CCW:{...basis.CCW,auxiliaryBranchReference_kg_s:700}},{siteWater_C:35},{extra:'equation'}])
    expect(()=>parseStationBasis(doc({...basis,...edit}))).toThrow()
  expect(()=>parseStationBasis(doc(basis)+doc(basis))).toThrow()
})
