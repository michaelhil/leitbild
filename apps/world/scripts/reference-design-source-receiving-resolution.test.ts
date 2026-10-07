import {describe,expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {compileReceivingResolution} from './reference-design-source-receiving-resolution'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {nativeMaterialSourceFixture} from './reference-design-source-transport-qualification'
import type {SourceFace} from './reference-design-source-faces'
import type {SourceRegion} from './reference-design-source-partition'

// Actual-owner evidence is optional in a standalone checkout. Nothing reads a
// sibling repository at import time, and skipped tests invent no physical input.
const wiki=process.env.LEITBILD_REFERENCE_WIKI,evidence=process.env.LEITBILD_REFERENCE_EVIDENCE
function actual(){
 const read=(p:string)=>readFileSync(p,'utf8'),partitionText=read(join(evidence!,'2026-10-05/operating-source-fixed-partition.json')),partition=JSON.parse(partitionText),
  fine=compileSourceEvolution(partitionText,
   read(join(evidence!,'2026-10-05/operating-source-cold-material-incidence.json')),
   read(join(evidence!,'2026-10-06/source-primary-original-water-coordinate-corrected.json')),
   new Map(sourceEvolutionOwnerFiles.map(p=>[p,read(join(wiki!,p))])),
   JSON.parse(read(join(evidence!,'2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json'))).receiving.property)
 return {partitionText,partition:partition as {result:{regions:SourceRegion[]}},fine,coarse:compileReceivingResolution(fine,partitionText)}
}
let cached:ReturnType<typeof actual>|undefined
const input=()=>cached??=actual()
const near=(a:number,b:number)=>expect(Math.abs(a-b)).toBeLessThanOrEqual(5e-10*Math.max(Math.abs(a),Math.abs(b),1e-30))
const sum=(a:readonly number[])=>a.reduce((s,x)=>s+x,0)

describe.skipIf(!wiki||!evidence)('actual ORIGINAL receiving resolution, no source advancement',()=>{
 test('retains the core and every head-bearing tile, without adding physical owners',()=>{
  const {fine,coarse,partition}=input(),regions=partition.result.regions,
   wellBottom=Math.min(...regions.filter(r=>r.compartment==='WELL').map(r=>r.z0_m!))
  expect(coarse.counts.regions).toBe(1618)
  expect(coarse.counts.neutronCoordinates).toBe(11326)
  expect(coarse.counts.physicalCoordinates).toBe(29106)
  expect(coarse.counts.physicalWaterOwners).toBe(14)
  expect(coarse.counts.finiteTargets).toBe(2053)
  for(const [i,r] of regions.entries())if(!['WELL','CANAL','POOL'].includes(r.compartment)
   ||r.compartment==='WELL'&&r.z0_m===wellBottom){
   expect(coarse.members[coarse.mapping[i]!]!).toEqual([i])
   expect(coarse.regions[coarse.mapping[i]!]!).toEqual(r)
  }
  expect(regions.filter(r=>r.compartment==='WELL'&&r.z0_m===wellBottom)).toHaveLength(100)
  expect(coarse.members.filter(m=>m.length>1)).toHaveLength(8)
  for(const compartment of ['ACTIVE','LOWER','UPPER','WELL','CANAL','POOL'])near(
   sum(regions.filter(r=>r.compartment===compartment).map(r=>r.volume_m3)),
   sum(coarse.regions.filter(r=>r.compartment===compartment).map(r=>r.volume_m3)))
  expect(coarse.nativeInputs.targets).toEqual(fine.material.nativeInputs.targets)
  expect(coarse.projection.owners).toEqual(fine.projection.owners)
  expect(coarse.manganese).toEqual(fine.manganese)
  expect(coarse.materialPayload.passive.nativeBulk.stocks).toEqual(fine.material.materialPayload.passive.nativeBulk.stocks)
  expect(coarse.history.preparation).toEqual(fine.history.preparation)
  expect(coarse.scope).toContain('No loaded racks')
  expect(coarse.noWholePlantReadinessCredit).toBe(true)
 },20_000)

 test('positive intersections preserve each actual material, water and birth contribution',()=>{
  const {fine,coarse}=input(),old=fine.material.nativeInputs
  expect(coarse.nativeInputs.fuel.intersections).toEqual(old.fuel.intersections.map(e=>({...e,region:coarse.mapping[e.region]!})))
  // Numerical intersections may merge, but each shared donor's amount and
  // source-outside fraction must survive without renormalization or cloning.
  const accumulate=(moderator:typeof old.moderator,projection:typeof fine.projection,map:(r:number)=>number)=>{
   const byOwnerRegion=new Map<string,number[]>()
   moderator.intersections.forEach((e,i)=>{
    const s=moderator.stocks[i]!,owner=projection.rows[i]!.owner,key=owner+'/'+map(e.region),
     amount=[e.volume,s.water_mass,s.liquid_volume,s.hydrogen_target,s.hydrogen_product,s.mobile_boron10],
     previous=byOwnerRegion.get(key)??amount.map(()=>0)
    byOwnerRegion.set(key,amount.map((v,j)=>v+previous[j]!))
   })
   return byOwnerRegion
  },before=accumulate(old.moderator,fine.projection,r=>coarse.mapping[r]!),
   after=accumulate(coarse.nativeInputs.moderator,coarse.projection,r=>r)
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
  for(const [key,amount] of before)amount.forEach((v,j)=>near(v,after.get(key)![j]!))
  expect(coarse.projection.owners).toEqual(fine.projection.owners)
  for(let owner=0;owner<fine.projection.owners.length;owner++)for(const key of ['h_fraction','b_fraction'] as const)near(
   sum(fine.projection.rows.filter(r=>r.owner===owner).map(r=>r[key])),
   sum(coarse.projection.rows.filter(r=>r.owner===owner).map(r=>r[key])))
  expect(coarse.history.support).toEqual(fine.history.support.map(e=>({...e,region:coarse.mapping[e.region]!})))
  expect(coarse.materialPayload.cylinder.intersections).toEqual(fine.material.materialPayload.cylinder.intersections
   .map(e=>({...e,region:coarse.mapping[e.region]!})))
  const bulk=fine.material.materialPayload.passive.nativeBulk
  const expectedBulk=new Map<string,number>(),actualBulk=new Map<string,number>()
  for(const e of bulk.incidence){const key=e.stock+'|'+coarse.mapping[e.region]!;expectedBulk.set(key,(expectedBulk.get(key)??0)+e.volume)}
  for(const e of coarse.materialPayload.passive.nativeBulk.incidence){
   const key=e.stock+'|'+e.region;expect(actualBulk.has(key)).toBe(false);actualBulk.set(key,e.volume)
  }
  expect([...actualBulk.keys()].sort()).toEqual([...expectedBulk.keys()].sort())
  for(const [key,volume] of expectedBulk)near(volume,actualBulk.get(key)!)
  const material=fine.material.materialPayload.passive.volumeMaterial,expectedMaterial=new Map<string,number>(),
   actualMaterial=new Map<string,number>()
  for(const e of material){const key=e.stockId+'|'+coarse.regions[coarse.mapping[e.region]!]!.id
   expectedMaterial.set(key,(expectedMaterial.get(key)??0)+e.volume_m3)}
  for(const e of coarse.materialPayload.passive.volumeMaterial){
   const key=e.stockId+'|'+e.sourceRegionId;expect(actualMaterial.has(key)).toBe(false)
   expect(coarse.regions[e.region]!.id).toBe(e.sourceRegionId)
   actualMaterial.set(key,e.volume_m3)
  }
  expect([...actualMaterial.keys()].sort()).toEqual([...expectedMaterial.keys()].sort())
  for(const [key,volume] of expectedMaterial)near(volume,actualMaterial.get(key)!)
  for(let s=0;s<bulk.stocks.length;s++)near(sum(bulk.incidence.filter(e=>e.stock===s).map(e=>e.volume)),
   sum(coarse.materialPayload.passive.nativeBulk.incidence.filter(e=>e.stock===s).map(e=>e.volume)))
  for(const [i,m] of coarse.members.entries()){
   expect(coarse.regions[i]!.envelopeLength_m).toBe(fine.material.nativeInputs.transport.envelopeLengths[m[0]!]!)
   expect(m.every(r=>old.transport.envelopeLengths[r]===coarse.regions[i]!.envelopeLength_m)).toBe(true)
  }
 })

 test('coarse boundary distances are rebuilt, while panel areas and ordered targets remain once-owned',()=>{
  const {fine,coarse,partition}=input(),old=fine.material.nativeInputs.transport,
   raw=(JSON.parse(fine.material.faceReceipt) as {result:{faces:SourceFace[]}}).result.faces,
   faces=coarse.nativeInputs.transport.faces,groups=new Map<number,number[]>(),seen=new Set<number>(),
   optical=new Map(fine.material.materialPayload.passive.opticalFaces.map(q=>[q.faceIndex,q]))
  let changedDistances=0,internal=0
  for(const q of coarse.faceMap){
   expect(seen.has(q.fine)).toBe(false);seen.add(q.fine)
   const f=old.faces[q.fine]!,r=raw[q.fine]!
   if(q.coarse===null){
    expect(f.law.kind).toBe('transparent');expect(f.right).toBeDefined()
    expect(coarse.mapping[f.left]).toBe(coarse.mapping[f.right!]!);continue
   }
   const c=faces[q.coarse]!,indices=groups.get(q.coarse)??[];indices.push(q.fine);groups.set(q.coarse,indices)
   if(c.law.kind==='internal-optical'){
    internal++;expect(r.support?.kind).toBe('rack-panel');expect(c.right).toBeUndefined()
    expect(c.left_distance).toBe(0);expect(c.right_distance).toBeUndefined()
    expect(c.area).toBe(f.area);expect(c.law.targets).toEqual(f.law.targets)
   }else for(const [ri,d,previous] of [[f.left,c.left_distance,f.left_distance],
    ...(f.right===undefined?[]:[[f.right,c.right_distance!,f.right_distance!]])] as [number,number,number][]){
    if(coarse.members[coarse.mapping[ri]!]!.length===1){expect(d).toBe(previous);continue}
    const region=coarse.regions[coarse.mapping[ri]!]!,axis=r.axis==='x'?0:r.axis==='y'?1:r.axis==='z'?2:undefined
    expect(axis).toBeDefined();expect(r.plane_m).toBeDefined()
    const centre=[(region.box!.x0+region.box!.x1)/2,(region.box!.y0+region.box!.y1)/2,(region.z0_m!+region.z1_m!)/2]
    near(d,Math.abs(centre[axis!]!-r.plane_m!));expect(d).toBeGreaterThan(0)
    if(d!==previous)changedDistances++
   }
   const op=optical.get(q.fine)
   if(op)expect(coarse.materialPayload.passive.opticalFaces.find(p=>p.faceIndex===q.coarse)!.layers).toEqual(op.layers)
  }
  expect(seen.size).toBe(old.faces.length);expect(changedDistances).toBeGreaterThan(0)
  expect(internal).toBe(coarse.counts.internalPanels);expect(internal).toBeGreaterThan(0)
  for(const [i,from] of groups)near(faces[i]!.area,sum(from.map(j=>old.faces[j]!.area)))
  expect(coarse.regions.every(r=>r.volume_m3>0)).toBe(true)
  expect(partition.result.regions).toHaveLength(coarse.counts.fineRegions)
 })

 test('loaded receiving fuel, diluted head, and stale identities are explicit refusals',()=>{
  const {fine,partitionText,partition,coarse}=input(),receiving=coarse.members.find(m=>m.length>1)![0]!,loaded=structuredClone(fine)
  loaded.material.nativeInputs.fuel.intersections[0]!.region=receiving
  expect(()=>compileReceivingResolution(loaded,partitionText)).toThrow('Loaded receiving')
  const diluted=structuredClone(fine),bulk=diluted.material.materialPayload.passive.nativeBulk,
   head=bulk.incidence.find(e=>bulk.stocks[e.stock]!.targets.some(t=>t.id.startsWith('HEAD.SLAB/')))!
  expect(head).toBeDefined();head.region=receiving
  expect(()=>compileReceivingResolution(diluted,partitionText)).toThrow('Head-bearing')
  const stale=structuredClone(partition);stale.result.regions[0]!.volume_m3*=1.001
  expect(()=>compileReceivingResolution(fine,JSON.stringify(stale))).toThrow()
 })

 test('serialized internal panels have a strict distinct protocol and no absent layer fallback',()=>{
  const {coarse}=input(),words=coarse.fixture.trim().split(/\s+/)
  let offset=0
  for(let frame=0;frame<4;frame++){
   const n=Number(words[offset]);expect(Number.isSafeInteger(n)&&n>0).toBe(true)
   offset+=n+1;expect(offset).toBeLessThanOrEqual(words.length)
  }
  expect(offset).toBe(words.length)
  const i=coarse.nativeInputs.transport.faces.findIndex(f=>f.law.kind==='internal-optical')
  expect(i).toBeGreaterThanOrEqual(0)
  for(const mutate of ['right','distance','layers'] as const){
   const ni=structuredClone(coarse.nativeInputs),payload=structuredClone(coarse.materialPayload),f=ni.transport.faces[i]!
   if(mutate==='right')f.right=0
   if(mutate==='distance')f.left_distance=1
   if(mutate==='layers')payload.passive.opticalFaces=payload.passive.opticalFaces.filter(q=>q.faceIndex!==i)
   expect(()=>nativeMaterialSourceFixture(ni,payload,ni.transport.regionVolumes.map(()=>Array(7).fill(0)))).toThrow('optical support')
  }
 })
})
