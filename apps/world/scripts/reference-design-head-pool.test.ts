import {describe,test,expect} from 'bun:test'
import {parseHeadPool,poolSelectionAllowed,headReleaseEvidence,runHeadPool} from './reference-design-head-pool'

// Portable schema/logic fixtures are not engineering owner defaults. Native
// property verification explicitly consumes the caller's actual wiki/Python.
const directory=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON
if(Boolean(directory)!==Boolean(python))throw Error('Set both LEITBILD_REFERENCE_WIKI and LEITBILD_REFERENCE_PYTHON for native verification')
const fixture={bayRim_m:15.5,baySpillWidths_m:[20,14,40],spillCoefficient:.6,
 cnvGasVolume_m3:60000,cnvPressure_Pa:101325,cnvTemperature_K:313.15,poolTracerRatio:.002,
 accessCdA_m2:1,accessForce_N:1000,accessPower_W:250,accessFixedFriction_N:200,
 accessPressureFrictionFactor:.2,accessPlateMass_kg:100,separatorVolume_m3:5,
 separatorArea_m2:1,separatorFloor_m:4,separatorTemperature_K:313.15,separatorMetal_kg:100,
 headLiftBase_m:16,headCradleX_m:-7,gantryTop_m:26,gantryForce_N:500000,gantryPower_W:20000,
 gantryEfficiency:.8,gantrySpeed_m_s:.02,gantryMetal_kg:1000,headDragCoefficient:1,
 headGapCd:.6,headReleaseDP_Pa:1000,poolLegDiameter_m:.3,poolMouth_m:8.75,poolTrain_m:4,
 poolLegHorizontal_m:10,poolDarcy:.02,poolLegFormLoss:2,poolISOReferenceLoss_Pa:10000,
 poolISOReferencePressure_Pa:101325,poolISOReferenceTemperature_K:298.15,
 ccwFixturePressure_Pa:300000,ccwFixtureTemperature_K:303.15,ccwFixtureFlow_kg_s:500,
 manualPinStroke_m:.01,manualPinSpeed_m_s:.001,manualPinForce_N:1000,manualPinPower_W:250,
 manualPinFriction_N:200,manualPinReactionFactor:.2,headLockLimit_N:500000000,
 poolAssessmentTemperature_K:333.15}
const doc='```reference-head-pool\n'+JSON.stringify(fixture)+'\n```\n'
describe('bounded head/pool engineering selection',()=>{
 test('strict record, not generic defaults',()=>{
  const text=doc,b=parseHeadPool(text)
  expect(b.gantryForce_N).toBe(500000)
  expect(b.headLiftBase_m).toBeGreaterThan(b.bayRim_m)
  expect(()=>parseHeadPool(text+text)).toThrow()
  expect(()=>parseHeadPool(text.replace('"gantryEfficiency":0.8','"gantryEfficiency":1.1'))).toThrow()
 })
 test('both actual alternatives and pending intent matter',()=>{
  const closed={usable:true,closed:true,pendingOpen:false}
  expect(poolSelectionAllowed([closed,closed])).toBe(true)
  expect(poolSelectionAllowed([closed,{...closed,pendingOpen:true}])).toBe(false)
  expect(poolSelectionAllowed([closed,{...closed,usable:false}])).toBe(false)
  expect(poolSelectionAllowed([closed,{...closed,closed:false}])).toBe(false)
  expect(()=>poolSelectionAllowed([closed])).toThrow()
 })
 test('paired intervals/acquired duration do not supply perfect physical DP',()=>{
  const usable={usable:true,low_Pa:-100,high_Pa:100,qualified_s:2}
  expect(headReleaseEvidence([usable,usable],1000)).toBe(true)
  expect(headReleaseEvidence([usable,{...usable,qualified_s:0}],1000)).toBe(false)
  expect(headReleaseEvidence([usable,{...usable,high_Pa:1001}],1000)).toBe(false)
  expect(headReleaseEvidence([usable,{...usable,usable:false}],1000)).toBe(false)
  // Fresh-stuck acquired intervals can be plausible despite actual dangerous
  // pressure. The native force check below must preserve that consequence.
  expect(headReleaseEvidence([usable,usable],1000)).toBe(true)
 })
 test.skipIf(!directory)('explicit offline native head/flow/work verification',async()=>{
  const r=await runHeadPool(directory!,python!)
  expect(r.head.staticLiftBound_N).toBeLessThan(r.consumedInput.selection.gantryForce_N)
  expect(r.head.traction_N-r.head.gravity_N).toBeGreaterThan(r.consumedInput.selection.gantryForce_N)
  expect(r.head.raisedTop_m).toBeLessThan(r.consumedInput.selection.gantryTop_m)
  expect(r.RHR.flowRows[2].delivered_kg_s).toBeGreaterThan(150)
  expect(r.RHR.flowRows[2].minflow_kg_s).toBeGreaterThan(0)
  expect(r.RHR.flowRows[2].conditionalHeat_W).toBeLessThan(r.RHR.referenceDuty_W)
  expect(r.RHR.flowRows[2].conditionalHeat_W).toBeGreaterThan(8e6)
  expect(r.RHR.flowRows[0].conditionalHeat_W).toBeLessThan(0)
  expect(r.RHR.flowRows[0].conditionalNetPoolRemoval_W).toBeLessThan(r.RHR.flowRows[0].conditionalHeat_W)
  expect(r.RHR.flowRows[2].conditionalNetPoolRemoval_W).toBeLessThan(r.RHR.flowRows[2].conditionalHeat_W)
  expect(r.consumedInput.train.retainedLoss_Pa).toBe(330000)
  expect(r.separatorCoupon.retainedTracer_kgEq).toBe(1e-6)
  expect(r.lowPressure).toHaveLength(20)
  expect(r.checks.find((q:{name:string})=>q.name==='Native saturation endpoints 1000').old300KBracketAdmits).toBe(false)
  expect(r.checks.find((q:{name:string})=>q.name==='Native saturation endpoints 3000').old300KBracketAdmits).toBe(false)
 },180000)
})
