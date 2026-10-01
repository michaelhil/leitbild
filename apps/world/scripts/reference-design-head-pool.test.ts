import {describe,test,expect} from 'bun:test'
import {resolve} from 'node:path'
import {parseHeadPool,poolSelectionAllowed,headReleaseEvidence,runHeadPool} from './reference-design-head-pool'

const directory=resolve(import.meta.dir,'../../../../Leitbild-wiki/world/packs/process-plant/reference-designs/ld-01')
const python='/Users/hilde/Documents/ChatGPT/Leitbild-research/reference-designs/.venv/bin/python'
describe('bounded head/pool engineering selection',()=>{
 test('strict original owned record, not generic defaults',async()=>{
  const text=await Bun.file(resolve(directory,'systems/reactor/head-and-pool-cooling.md')).text(),b=parseHeadPool(text)
  expect(b.gantryForce_N).toBe(500000)
  expect(b.headLiftBase_m).toBeGreaterThan(b.bayRim_m)
  expect(()=>parseHeadPool(text+text)).toThrow()
  expect(()=>parseHeadPool(text.replace('"gantryEfficiency": 0.8','"gantryEfficiency": 1.1'))).toThrow()
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
 test('actual native head/flow/work and contrary physical states',async()=>{
  const r=await runHeadPool(directory,python)
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
