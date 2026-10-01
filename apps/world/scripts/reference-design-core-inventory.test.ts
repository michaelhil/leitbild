import {describe,test,expect} from 'bun:test'
import {resolve} from 'node:path'
import {parseCoreInventory,fixedDensityHeight,heatedProbeHeat,heatedComparison,runCoreInventory} from './reference-design-core-inventory'
import {cetBasisSchema} from './reference-design-cet'
const directory=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON
if(Boolean(directory)!==Boolean(python))throw Error('Set both LEITBILD_REFERENCE_WIKI and LEITBILD_REFERENCE_PYTHON for native verification')
const fixture={coreBottom_m:-2,coreTop_m:2,headTop_m:4,coreArea_m2:4.679531,gravity_m_s2:9.80665,
 referencePressure_Pa:2000000,calibrationTemperature_K:313.15,dpLag_s:.5,dpQuantum_Pa:100,
 dpUncertainty_Pa:200,heaterResistance_ohm:28800,heaterVoltage_V:120,temperatureUncertainty_K:.2,
 temperatureQuantum_K:.1,powerUncertainty_W:.02,powerQuantum_W:.01,minimumTestPower_W:.47,maximumTestPower_W:.53}
const doc='```reference-core-inventory\n'+JSON.stringify(fixture)+'\n```\n'
const cet=cetBasisSchema.parse({diameter_m:.003,length_m:.03,density_kg_m3:8000,
 heatCapacity_J_kgK:500,conductivity_W_mK:15,leadDiameter_m:.0002,leadLength_m:.1,
 liquidFilm_W_m2K:1000,gasFilm_W_m2K:30,effectiveRadiationFactor:.03,minimumBody_C:20,maximumBody_C:800})
describe('physical core inventory observation selection',()=>{
 test('strict consumed record and signed display do not supply a level truth',()=>{
  const text=doc,b=parseCoreInventory(text)
  expect(b.coreTop_m-b.coreBottom_m).toBe(4)
  expect(b.heaterVoltage_V**2/b.heaterResistance_ohm).toBe(.5)
  expect(()=>parseCoreInventory(text+text)).toThrow()
  expect(fixedDensityHeight(-100,1000,10)).toBe(-.01)
  expect(fixedDensityHeight(100000,1000,10)).toBe(10)
  expect(()=>fixedDensityHeight(0,0,10)).toThrow()
 })
 test('electrical input and opposite thermal recipients close once',()=>{
  const b=cet
  for(const liquidExposure of [0,.5,1]){
   const q=heatedProbeHeat(b,100,{liquidExposure,liquid_C:40,gas_C:300,clad:[{areaWeight:1,temperature_C:700}]},.5)
   expect(Math.abs(q.probe_W+q.liquid_W+q.gas_W+q.clad_W.reduce((a,c)=>a+c,0)+q.electrical_W)).toBeLessThan(1e-12)
  }
  expect(()=>heatedProbeHeat(b,100,{liquidExposure:1,liquid_C:40,clad:[{areaWeight:1,temperature_C:40}]},-.1)).toThrow()
 })
 test('contact, radiation, unequal-contact ambiguity and retained histories',()=>{
  const r=heatedComparison(cet,.5,[fixture.minimumTestPower_W,.5,fixture.maximumTestPower_W])
  expect(r.rows).toHaveLength(108)
  expect(Math.max(...r.rows.filter(q=>q.liquidExposure===1).map(q=>q.difference_K))).toBeLessThan(3.4)
  expect(Math.min(...r.rows.filter(q=>q.liquidExposure===0).map(q=>q.difference_K))).toBeGreaterThan(25)
  expect(r.mimickingDryAbsoluteDifference.referenceFilmFactor).toBeGreaterThan(.5)
  expect(r.mimickingDryAbsoluteDifference.referenceFilmFactor).toBeLessThan(1)
  expect(r.drying[0]!.difference_K).toBeCloseTo(r.wetDifference_K,12)
  expect(r.drying[1]!.difference_K).toBeLessThan(r.dryDifference_K)
  expect(r.rewetting[0]!.difference_K).toBeCloseTo(r.dryDifference_K,12)
  expect(Math.min(...r.stepRows.filter(q=>q.liquidExposure===0).map(q=>q.increment120_K))).toBeGreaterThan(20)
  expect(Math.max(...r.stepRows.filter(q=>q.liquidExposure===1).map(q=>q.increment120_K))).toBeLessThan(3.6)
  expect(r.stepRows).toHaveLength(324)
  // A partial-contact response is NOT complete wetness or global cover.
  expect(r.stepRows.some(q=>q.liquidExposure===.5&&q.increment120_K<4.5)).toBe(true)
 },30000)
 test.skipIf(!directory)('explicit offline native DP contact verification',async()=>{
  const owner=resolve(directory!,'systems/instrumentation/core-inventory-observation.md'),cetOwner=resolve(directory!,'systems/instrumentation/phase-dependent-measurements.md')
  const r=await runCoreInventory(owner,cetOwner,python!),a=r.hydro.rows[3],b=r.hydro.rows[4]
  expect(Math.abs(a.DP_Pa-b.DP_Pa)).toBeLessThan(.001)
  expect(r.hydro.maskingDynamicHead_Pa).toBeGreaterThan(8000)
  expect(r.hydro.rows[1].indicatedHeight_m).toBeLessThan(3.6)
  expect(r.hydro.rows[0].indicatedHeight_m).toBeGreaterThan(4)
 },60000)
})
