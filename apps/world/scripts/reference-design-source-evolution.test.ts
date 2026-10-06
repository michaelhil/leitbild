import {describe,expect,test} from 'bun:test'
import {compileSharedWaterProjection,compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {qualifySourceEvolution,sourceDependencyPath,sourceEvolutionOutput} from './reference-design-source-evolution-qualification'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'

const amount=(H:number,B:number,V:number)=>({Htarget:H,mobileN10:B,volume_m3:V,HcaptureProduct:0})
test('dependency retention resolves explicit and implicit TypeScript extensions once',()=>{
 expect(sourceDependencyPath('/tmp/source','./reference-design-fuel-materials.ts')).toBe('/tmp/source/reference-design-fuel-materials.ts')
 expect(sourceDependencyPath('/tmp/source','./reference-design-fuel-materials')).toBe('/tmp/source/reference-design-fuel-materials.ts')
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
