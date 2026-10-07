import {describe,expect,test} from 'bun:test'
import {compileSharedWaterProjection,compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {auditSourceStage,qualifySourceEvolution,sourceDependencyPath,sourceEvolutionOutput,sourceProcessUsage,priorSourceComputationSeconds,sourcePairAdmission} from './reference-design-source-evolution-qualification'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {projectSourceCheckpoint} from './reference-design-source-receiving-resolution'

const amount=(H:number,B:number,V:number)=>({Htarget:H,mobileN10:B,volume_m3:V,HcaptureProduct:0})
test('pair admission requires the prospectively selected policy, actual refinement and all complete gates',()=>{
 const arm={passed:true,lastAdmittedTime:300},r={passed:true,lastAdmittedTime:300,physicalCoordinates:52962,
  normal:arm,tighter:arm,settings:{horizon:300,accuracyPolicy:'source-consequences-1',provisional:true,absoluteToleranceRefinement:10,rtol:[1e-5,1e-6]},
  gates:{fullPairComparisonEvaluated:true,localPairRatio:.1,SUMABSFamilyPairRatio:.2,observablePairRatio:.3,NCOperatorPairRatio:.4,
   comparedFamilyOutputs:1,developedSignal:true,strictAcceptedBoundary:true},rawAtomCountDiagnostic:{localPairRatio:13.04}}
 expect(sourcePairAdmission.safeParse(r).success).toBe(true)
 for(const settings of [{...r.settings,accuracyPolicy:'old'},{...r.settings,absoluteToleranceRefinement:1},
  {...r.settings,rtol:[1e-5,1e-5]},{...r.settings,provisional:false}])expect(sourcePairAdmission.safeParse({...r,settings}).success).toBe(false)
 for(const key of ['localPairRatio','SUMABSFamilyPairRatio','observablePairRatio','NCOperatorPairRatio']){
  for(const value of [undefined,null,NaN,Infinity,-1,1.01])expect(sourcePairAdmission.safeParse({...r,gates:{...r.gates,[key]:value}}).success).toBe(false)
 }
 expect(sourcePairAdmission.safeParse({...r,gates:{...r.gates,fullPairComparisonEvaluated:false}}).success).toBe(false)
 expect(sourcePairAdmission.safeParse({...r,tighter:{...arm,lastAdmittedTime:.1}}).success).toBe(false)
})
test('checkpoint projection retains failed ledger and supplied slope, never repairs them',()=>{
 const bytes=Buffer.alloc(33+16*18);bytes.write('LDSOURCE1');bytes.writeBigUInt64LE(18n,9);bytes.writeDoubleLE(.557,17);bytes.writeDoubleLE(1e-5,25)
 const y=[...Array.from({length:14},(_,i)=>i+1),107,11,12,13],yp=y.map(x=>-2*x)
 for(const [which,values] of [y,yp].entries())values.forEach((v,i)=>bytes.writeDoubleLE(v,33+8*(which*18+i)))
 const coarse={mapping:[0,0],counts:{fineRegions:2,regions:1,neutronCoordinates:7,physicalCoordinates:7,
  physicalWaterOwners:0,finiteTargets:0,internalPanels:0,faces:0}},q=projectSourceCheckpoint(bytes,coarse,0)
 expect(q.drifts.map(d=>[d.before,d.after])).toEqual([[-2,-2],[4,4]])
 expect(Array.from({length:7},(_,i)=>q.bytes.readDoubleLE(33+8*i))).toEqual([9,11,13,15,17,19,21])
 expect(Array.from({length:4},(_,i)=>q.bytes.readDoubleLE(33+8*(7+i)))).toEqual([107,11,12,13])
 expect(q.time).toBe(.557);expect(q.rtol).toBe(1e-5);expect(q.noConservationRepair).toBe(true)
 expect(()=>projectSourceCheckpoint(bytes.subarray(1),coarse,0)).toThrow('format')
 const bad=Buffer.from(bytes);bad.writeDoubleLE(NaN,33)
 expect(()=>projectSourceCheckpoint(bad,coarse,0)).toThrow('Nonfinite')
 expect(()=>projectSourceCheckpoint(bytes,{...coarse,mapping:[0,2]},0)).toThrow('map')
})
test('dependency retention resolves explicit and implicit TypeScript extensions once',()=>{
 expect(sourceDependencyPath('/tmp/source','./reference-design-fuel-materials.ts')).toBe('/tmp/source/reference-design-fuel-materials.ts')
 expect(sourceDependencyPath('/tmp/source','./reference-design-fuel-materials')).toBe('/tmp/source/reference-design-fuel-materials.ts')
})
test('native process cost getters become JSON-safe measurements, not an empty object',async()=>{
 const child=Bun.spawn([process.execPath,'-e','0'],{stdout:'pipe',stderr:'pipe'})
 await child.exited
 const usage=sourceProcessUsage(child.resourceUsage()),json=JSON.parse(JSON.stringify(usage))
 expect(child.exitCode).toBe(0)
 expect(json.peakRSSBytes).toBeGreaterThan(0)
 for(const key of ['user','system','total']){
  expect(Number.isFinite(json.cpuSeconds[key])).toBe(true)
  expect(json.cpuSeconds[key]).toBeGreaterThanOrEqual(0)
 }
 expect(json.cpuSeconds.total).toBeCloseTo(json.cpuSeconds.user+json.cpuSeconds.system,6)
 expect(sourceProcessUsage(undefined)).toEqual({cpuSeconds:null,peakRSSBytes:null})
})
test('an external stop retains a checkpoint but cannot turn progress into a final result',()=>{
 const line=JSON.stringify({kind:'admitted-progress',lastAdmittedTime:7.4e-8}),partial=sourceEvolutionOutput(line+'\n')
 expect(partial.outcome).toBeUndefined();expect(partial.retainedState.lastAdmittedTime).toBe(7.4e-8)
 const completed=sourceEvolutionOutput(line+'\n'+JSON.stringify({passed:false,lastAdmittedTime:7.4e-8})+'\n')
 expect(completed.outcome.passed).toBe(false);expect(completed.retainedState.lastAdmittedTime).toBe(7.4e-8)
 expect(sourceEvolutionOutput('not-json').records[0]).toEqual({unparsed:'not-json'})
 expect(sourceEvolutionOutput('null\n42\n').outcome).toBeUndefined()
})
test('qualification refuses overwriting evidence or unpinned dependencies before preparation',async()=>{
 await expect(qualifySourceEvolution('unused','unused','unused','unused','unused',import.meta.path,[])).rejects.toThrow('overwrite')
 await expect(qualifySourceEvolution('unused','unused','unused','unused','unused',import.meta.path+'.absent',[])).rejects.toThrow('dependency artifacts')
 await expect(qualifySourceEvolution('unused','unused','unused','unused','unused',import.meta.path+'.absent',[import.meta.path])).rejects.toThrow('Explicit selected IDA')
})
test('qualification refuses an implicit Cargo target before compilation or input preparation',async()=>{
 const prefix=process.env.LEITBILD_SUNDIALS_PREFIX,target=process.env.CARGO_TARGET_DIR
 process.env.LEITBILD_SUNDIALS_PREFIX='/not-used-test-prefix';delete process.env.CARGO_TARGET_DIR
 try{
  await expect(qualifySourceEvolution('unused','unused','unused','unused','unused',import.meta.path+'.absent',
   [import.meta.path],undefined,'/not-used-test-ida')).rejects.toThrow('target directory required before compilation')
 }finally{
  if(prefix===undefined)delete process.env.LEITBILD_SUNDIALS_PREFIX;else process.env.LEITBILD_SUNDIALS_PREFIX=prefix
  if(target===undefined)delete process.env.CARGO_TARGET_DIR;else process.env.CARGO_TARGET_DIR=target
 }
})
test('prior computation debits actual failed work without granting admission or falsifying its role',()=>{
 const output='/tmp/next-pair.json',prior={elapsedSeconds:4.2,debitedTo:'next-pair.json',passed:false,simulationStarted:true,artifactsCreated:true}
 expect(priorSourceComputationSeconds(prior,output)).toBe(4.2)
 expect(priorSourceComputationSeconds({...prior,elapsedSeconds:0},output)).toBe(0)
 expect(prior).toEqual({elapsedSeconds:4.2,debitedTo:'next-pair.json',passed:false,simulationStarted:true,artifactsCreated:true})
 for(const elapsedSeconds of [-1,NaN,Infinity,120,121])expect(()=>priorSourceComputationSeconds({...prior,elapsedSeconds},output)).toThrow()
 for(const bad of [null,[],{},''])expect(()=>priorSourceComputationSeconds(bad,output)).toThrow()
 expect(()=>priorSourceComputationSeconds({...prior,debitedTo:'other.json'},output)).toThrow()
})
test('nonadvancing actual-stage audit refuses invalid stages and evidence overwrite',async()=>{
 await expect(auditSourceStage('unused','unused','unused',NaN,import.meta.path+'.absent')).rejects.toThrow('finite')
 await expect(auditSourceStage('unused','unused','unused',77,import.meta.path)).rejects.toThrow('overwrite')
})
function projectionFixture(){
 const primary={passed:true,inputs:{},geometry:{},result:{nativeOwners:[{owner:'DOWN',total:amount(30,3,3),
  represented:amount(20,2,2),outsideSource:amount(10,1,1)}],sourceIncidence:[
   {owner:'DOWN',sourceRegionId:'A',amount:amount(10,1,1)},{owner:'DOWN',sourceRegionId:'B',amount:amount(10,1,1)}]}},
  receiving={nativeOwners:[],sourceIncidence:[]},moderator={identities:{rows:['DOWN|A','DOWN|B']},stocks:[0,1].map(()=>({
   hydrogen_target:10,mobile_boron10:1,liquid_volume:1,hydrogen_product:0}))}
 return {primary,receiving:receiving as unknown as Parameters<typeof compileSharedWaterProjection>[1],
  moderator:moderator as unknown as Parameters<typeof compileSharedWaterProjection>[2]}
}
test('one physical donor retains outside-source inventory without renormalizing rows',()=>{
 const f=projectionFixture(),q=compileSharedWaterProjection(f.primary,f.receiving,f.moderator)
 expect(q.owners).toHaveLength(1);expect(q.rows.map(r=>r.owner)).toEqual([0,0])
 expect(q.owners[0]!.hydrogen).toBe(30);expect(q.rows.reduce((s,r)=>s+r.h_fraction,0)).toBeCloseTo(2/3,14)
 expect(q.rows.reduce((s,r)=>s+r.b_fraction,0)).toBeCloseTo(2/3,14)
})
test('stale, duplicate, missing and overrepresented donor projections refuse',()=>{
 const f=projectionFixture()
 expect(()=>compileSharedWaterProjection({...f.primary,passed:false},f.receiving,f.moderator)).toThrow()
 expect(()=>compileSharedWaterProjection({...f.primary,result:{...f.primary.result,nativeOwners:[...f.primary.result.nativeOwners,...f.primary.result.nativeOwners]}},f.receiving,f.moderator)).toThrow('duplicated')
 const p=structuredClone(f.primary);p.result.nativeOwners[0]!.total.Htarget=20
 expect(()=>compileSharedWaterProjection(p,f.receiving,f.moderator)).toThrow('close')
 expect(()=>compileSharedWaterProjection(f.primary,f.receiving,{...f.moderator,identities:{...f.moderator.identities,rows:['DOWN|A','DOWN|A']}})).toThrow('duplicated')
 expect(()=>compileSharedWaterProjection({...f.primary,result:{...f.primary.result,sourceIncidence:f.primary.result.sourceIncidence.slice(1)}},f.receiving,f.moderator)).toThrow('coverage')
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,evidence=process.env.LEITBILD_REFERENCE_EVIDENCE
describe.skipIf(!wiki||!evidence)('actual source advancement compilation',()=>{
 test('all current physical source owners join and outside DOWN remains retained',()=>{
  const r=(p:string)=>readFileSync(p,'utf8'),prepared=compileSourceEvolution(
   r(join(evidence!,'2026-10-05/operating-source-fixed-partition.json')),
   r(join(evidence!,'2026-10-05/operating-source-cold-material-incidence.json')),
   r(join(evidence!,'2026-10-06/source-primary-original-water-coordinate-corrected.json')),
   new Map(sourceEvolutionOwnerFiles.map(p=>[p,r(join(wiki!,p))])),
   JSON.parse(r(join(evidence!,'2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json'))).receiving.property)
  expect(prepared.counts.evolvedCoordinates).toBe(52962);expect(prepared.manganese).toHaveLength(258)
  const down=prepared.projection.owners.findIndex(o=>o.id==='DOWN')
  expect(down).toBeGreaterThanOrEqual(0)
  expect(prepared.projection.rows.filter(q=>q.owner===down).reduce((s,q)=>s+q.h_fraction,0)).toBeCloseTo(2/3,8)
  expect(prepared.history.counts.totalCoordinates).toBe(50623)
  expect(createHash('sha256').update(prepared.material.fixture).digest('hex')).toBe(JSON.parse(r(join(evidence!,
   '2026-10-06/source-composed-cylinder-converter-1.json'))).fixtureSHA256)
  expect(prepared.projection.owners.every(q=>q.hydrogen_product===0&&q.boron_product===0)).toBe(true)
 },20_000)
})
