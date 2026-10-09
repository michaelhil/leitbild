import {beforeAll,describe,expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {compileOriginalPassiveGeometry,controlSteelPrimitives} from './reference-design-source-passive'
import {compileControlSteelMotion,controlSteelMotionAt,type ControlSteelPose} from './reference-design-control-material-motion'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileSourcePartition} from './reference-design-source-partition'
import {compileSourceFaces} from './reference-design-source-faces'
import {compileColdSourceMaterial,parseOperatingFuelCohorts} from './reference-design-source-material'
import {parseNuclearObservation} from './reference-design-nuclear-observation'
import {parseColdNuclear} from './reference-design-cold-nuclear'
import {transferAttachmentChecks} from './reference-design-fuel-transfer'

const wiki=process.env.LEITBILD_REFERENCE_WIKI
describe.skipIf(!wiki)('selected moving structural steel uses the actual material once',()=>{
 let d:ReturnType<typeof parsePrimaryWaterInputs>,partition:ReturnType<typeof compileSourcePartition>,
  material:ReturnType<typeof compileColdSourceMaterial>,faces:ReturnType<typeof compileSourceFaces>['faces'],source:string,
  old:ReturnType<typeof compileOriginalPassiveGeometry>,augmented:ReturnType<typeof compileOriginalPassiveGeometry>,
  plan:ReturnType<typeof compileControlSteelMotion>,poses:ControlSteelPose[]
 beforeAll(()=>{
  const read=(name:string)=>readFileSync(join(wiki!,name),'utf8')
  d=parsePrimaryWaterInputs(primaryWaterOwnerFiles.map(read));partition=compileSourcePartition(d)
  source=read('systems/reactor/configuration-source-and-history.md')
  material=compileColdSourceMaterial(partition,{fuel:d.fuel,handling:d.handling,
   grid:parseOperatingFuelCohorts(read('systems/reactor/radial-energy-transient.md')),
   apparatus:parseNuclearObservation(read('systems/instrumentation/nuclear-observation-apparatus.md')),
   source:{birthEmission_neutrons_s:parseColdNuclear(read('systems/reactor/cold-source-and-startup.md')).source.birthEmission_neutrons_s}})
  faces=compileSourceFaces(partition,d.gates,[0,0]).faces
  old=compileOriginalPassiveGeometry(partition,d,material,faces,source)
  augmented=compileOriginalPassiveGeometry(partition,d,material,faces,source,{controlSteel:true})
  plan=compileControlSteelMotion(partition.regions,d,augmented.stocks,{body:1.5,stem:1.5})
  poses=plan.clusters.map(c=>({clusterId:c.id,body_y_m:0,stem_y_m:0,side:'increasing',stem_side:'increasing'}))
 },20_000)
 test('explicit selection adds104 original304 identities and416 targets; no old inventory changes',()=>{
  expect(augmented.stocks).toHaveLength(old.stocks.length+104)
  expect(augmented.stocks.slice(0,old.stocks.length)).toEqual(old.stocks)
  const added=augmented.stocks.slice(old.stocks.length)
  expect(new Set(added.map(s=>s.id)).size).toBe(104)
  expect(added.flatMap(s=>s.targets)).toHaveLength(416)
  expect(added.every(s=>s.material==='steel304'&&s.captureMode==='volume'&&s.targets.length===4
   &&s.targets.every(t=>t.atoms===t.referenceAtoms&&t.productAtoms===0))).toBe(true)
  expect(added.flatMap(s=>s.targets).filter(t=>t.id.endsWith('/Mn'))).toHaveLength(104)
  expect(augmented.receivingPieces).toEqual(old.receivingPieces)
  expect(augmented.bayClosure).toEqual(old.bayClosure)
  expect(augmented.opticalFaces).toEqual(old.opticalFaces)
  expect(compileOriginalPassiveGeometry(partition,d,material,faces,source,{controlSteel:false})).toEqual(old)
  expect(compileOriginalPassiveGeometry(partition,d,material,faces,source,{controlSteel:true})).toEqual(augmented)
 },20_000)
 test('source mass is existing spider and complete shaft/stub/lug/shoulder mass, not bare stem only',()=>{
  const attachment=transferAttachmentChecks(d.attachment,d.control,d.fuel,d.handling).geometry,
   added=augmented.stocks.slice(old.stocks.length),sum=(family:string)=>added.filter(s=>s.id.endsWith('/'+family)).reduce((v,s)=>v+s.mass_kg,0)
  expect(sum('SPIDER')).toBeCloseTo(d.control.clusters*d.control.spiderMass_kg,10)
  expect(sum('STEM')).toBeCloseTo(attachment.headCapturedStem_kg,10)
  expect(sum('STEM')).toBeGreaterThan(d.control.clusters*Math.PI*(d.control.stemDiameter_m/2)**2*d.control.stemLength_m*d.control.steelDensity_kg_m3)
  expect(controlSteelPrimitives(d).rows.filter(r=>r.shape.kind==='distributed').every(r=>r.hi+1.5<=d.control.headBottom_m)).toBe(true)
 })
 test('new reachable rows reproduce every ORIGINAL material intersection',()=>{
  const at=controlSteelMotionAt(plan,poses),original=new Map(augmented.nativeBulk.incidence.map(r=>[r.stock+'/'+r.region,r.volume]))
  expect(new Set(plan.rows.map(r=>r.stock)).size).toBe(104)
  for(const [i,r]of plan.rows.entries())expect(at[4*i]!).toBeCloseTo(original.get(r.stock+'/'+r.region)??0,13)
 })
 test('test-only finer WELL partition retains zero-support shaft entering derivatives',()=>{
  const split=d.control.spiderBottom_m+d.control.spiderHeight_m+d.control.stemLength_m,
   regions=partition.regions.flatMap(r=>r.compartment==='WELL'&&r.z0_m!<split&&r.z1_m!>split?[
    {...r,id:r.id+'/below',z1_m:split,volume_m3:r.volume_m3*(split-r.z0_m!)/(r.z1_m!-r.z0_m!)},
    {...r,id:r.id+'/above',z0_m:split,volume_m3:r.volume_m3*(r.z1_m!-split)/(r.z1_m!-r.z0_m!)},
   ]:[r]),finer=compileControlSteelMotion(regions,d,augmented.stocks,{body:1.5,stem:1.5}),at=controlSteelMotionAt(finer,poses)
  expect(finer.rows.some((r,i)=>r.motion==='stem'&&at[4*i]===0&&at[4*i+1]!>0)).toBe(true)
 })
 test('nonuniform stem/body translations preserve whole-stock V/J and separate material motion',()=>{
  const before=JSON.stringify(augmented.stocks),original=controlSteelMotionAt(plan,poses),
   currentPoses=poses.map((p,i)=>({...p,body_y_m:.003+i*.00001,stem_y_m:.27+i*.0001})),current=controlSteelMotionAt(plan,currentPoses)
  for(const [stock,s]of augmented.stocks.entries())if(stock>=old.stocks.length){
   const local=plan.rows.map((r,i)=>({r,i})).filter(q=>q.r.stock===stock),first=local[0]!.r,
    y=first.motion==='body'?currentPoses[first.cluster]!.body_y_m:currentPoses[first.cluster]!.stem_y_m,
    sum=(v:Float64Array,k:number)=>local.reduce((a,q)=>a+v[4*q.i+k]!,0)
   expect(sum(current,0)).toBeCloseTo(s.volume_m3,12)
   expect(sum(current,2)-sum(original,2)).toBeCloseTo(s.volume_m3*y,12)
   expect(sum(current,1)).toBeCloseTo(0,12);expect(sum(current,3)).toBeCloseTo(s.volume_m3,12)
  }
  const stemOnly=controlSteelMotionAt(plan,poses.map(p=>({...p,stem_y_m:.27})))
  for(const [i,r]of plan.rows.entries())if(r.motion==='body')expect([...stemOnly.slice(4*i,4*i+4)]).toEqual([...original.slice(4*i,4*i+4)])
  expect(controlSteelMotionAt(plan,poses)).toEqual(original);expect(JSON.stringify(augmented.stocks)).toBe(before)
 })
 test('actual shaft crossing partials match independent signed translations',()=>{
  const p=poses.map(q=>({...q,body_y_m:.003,stem_y_m:.271})),v=controlSteelMotionAt(plan,p),h=1e-5,
   a=controlSteelMotionAt(plan,p.map(q=>({...q,body_y_m:q.body_y_m-h,stem_y_m:q.stem_y_m-h}))),
   b=controlSteelMotionAt(plan,p.map(q=>({...q,body_y_m:q.body_y_m+h,stem_y_m:q.stem_y_m+h})))
  for(const [i]of plan.rows.entries()){
   expect((b[4*i]!-a[4*i]!)/(2*h)).toBeCloseTo(v[4*i+1]!,10)
   expect((b[4*i+2]!-a[4*i+2]!)/(2*h)).toBeCloseTo(v[4*i+3]!,10)
  }
 })
 test('both legal sides at every actual clipping cut preserve rigid translation',()=>{
  const stock=plan.rows.find(r=>r.motion==='stem')!.stock,local=plan.rows.map((r,i)=>({r,i})).filter(q=>q.r.stock===stock),
   cluster=local[0]!.r.cluster,cuts=new Set([0,1.5]),V=augmented.stocks[stock]!.volume_m3
  for(const {r}of local)for(const s of r.spans)for(const y of [r.lo-s.lo,r.lo-s.hi,r.hi-s.lo,r.hi-s.hi])if(y>0&&y<1.5)cuts.add(y)
  for(const y of cuts)for(const side of ['increasing','decreasing'] as const){
   if(y===0&&side==='decreasing'||y===1.5&&side==='increasing')continue
   const v=controlSteelMotionAt(plan,poses.map((p,i)=>i===cluster?{...p,stem_y_m:y,stem_side:side}:p)),
    sum=(k:number)=>local.reduce((a,q)=>a+v[4*q.i+k]!,0)
   expect(sum(0)).toBeCloseTo(V,12);expect(sum(1)).toBeCloseTo(0,12);expect(sum(3)).toBeCloseTo(V,12)
  }
 })
 test('missing/duplicate stocks, lost source support and unselected transverse travel refuse',()=>{
  expect(()=>compileControlSteelMotion(partition.regions,d,old.stocks,{body:1.5,stem:1.5})).toThrow('Missing moving structural')
  expect(()=>compileControlSteelMotion(partition.regions,d,[...augmented.stocks,augmented.stocks.at(-1)!],{body:1.5,stem:1.5})).toThrow('Duplicate')
  expect(()=>compileControlSteelMotion(partition.regions.filter(r=>r.compartment!=='WELL'),d,augmented.stocks,{body:1.5,stem:1.5})).toThrow('coverage')
  expect(()=>compileControlSteelMotion(partition.regions,d,augmented.stocks,{body:4,stem:4})).toThrow('lumped UPPER domain')
  expect(()=>controlSteelMotionAt(plan,poses.map(p=>({...p,stem_y_m:1.500001})))).toThrow('pose')
  expect(()=>controlSteelMotionAt(plan,[poses[1]!,poses[0]!,...poses.slice(2)])).toThrow('pose')
 })
 test('selected shoulder/collar signed reach preserves actual104stocks across all cuts and restores ORIGINAL',()=>{
  const minimum=d.control.collarBottoms_m[1]!+d.control.collarHeight_m-d.attachment.shoulderBottom_m,
   signed=compileControlSteelMotion(partition.regions,d,augmented.stocks,{body:1.5,stem:1.54},minimum),
   original=controlSteelMotionAt(signed,poses),before=JSON.stringify(augmented.stocks)
  expect(signed.minimum).toEqual({body:0,stem:minimum})
  expect(new Set(signed.rows.map(r=>r.stock)).size).toBe(104)
  for(const y of [minimum,minimum/2,0,.25]){
   const current=controlSteelMotionAt(signed,poses.map((p,i)=>({...p,stem_y_m:y+(0-y)*i/51,
    stem_side:y===0?'decreasing' as const:'increasing' as const})))
   for(const [stock,s]of augmented.stocks.entries())if(stock>=old.stocks.length){
    const local=signed.rows.map((r,i)=>({r,i})).filter(q=>q.r.stock===stock),sum=(k:number)=>local.reduce((a,q)=>a+current[4*q.i+k]!,0)
    expect(sum(0)).toBeCloseTo(s.volume_m3,12);expect(sum(1)).toBeCloseTo(0,12)
    expect(sum(3)).toBeCloseTo(s.volume_m3,12)
   }
  }
  expect(controlSteelMotionAt(signed,poses)).toEqual(original)
  expect(JSON.stringify(augmented.stocks)).toBe(before)
  expect(()=>compileControlSteelMotion(partition.regions,d,augmented.stocks,{body:1.5,stem:1.54},-1)).toThrow('lumped UPPER')
 })
})
