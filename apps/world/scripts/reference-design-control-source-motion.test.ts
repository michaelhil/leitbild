import {describe,expect,beforeAll,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {compileControlSourceMotion,controlSourceMotionAt,nativeControlSourceStage,nativeControlSourceFixture,type ControlSourcePose} from './reference-design-control-source-motion'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileSourceFaces} from './reference-design-source-faces'
import {compileOriginalPassiveGeometry} from './reference-design-source-passive'
import {compileCylinderInputs} from './reference-design-source-cylinder'
import {parseNuclearObservation} from './reference-design-nuclear-observation'

const wiki=process.env.LEITBILD_REFERENCE_WIKI
describe.skipIf(!wiki)('one actual current control/source geometry view',()=>{
 let plan:ReturnType<typeof compileControlSourceMotion>,original:ReturnType<typeof controlSourceMotionAt>,
  poses:ControlSourcePose[],p:Awaited<ReturnType<typeof compileFuelCooling>>,
  passive:ReturnType<typeof compileOriginalPassiveGeometry>,cylinder:ReturnType<typeof compileCylinderInputs>
 beforeAll(async()=>{
  const read=(path:string)=>readFileSync(join(wiki!,path),'utf8'),d=parsePrimaryWaterInputs(primaryWaterOwnerFiles.map(read)),
   text=read('systems/reactor/configuration-source-and-history.md')
  p=await compileFuelCooling(wiki!)
  passive=compileOriginalPassiveGeometry(p.material.partition,d,p.material.result,
   compileSourceFaces(p.material.partition,d.gates,[0,0]).faces,text)
  cylinder=compileCylinderInputs(p.material.partition,d,p.material.result,passive,
   parseNuclearObservation(read('systems/instrumentation/nuclear-observation-apparatus.md')),text)
  plan=compileControlSourceMotion(d,p,passive,cylinder)
  poses=plan.motion.clusters.map(c=>({clusterId:c.id,body_y_m:0,stem_y_m:0,side:'increasing',stem_side:'increasing',contact:'seated'}))
  original=controlSourceMotionAt(plan,poses)
 },30_000)
 test('ORIGINAL split preserves all geometry, material identities and physical stocks once',()=>{
  expect(plan.guideCells).toHaveLength(52)
  expect(plan.water).toHaveLength(p.network.water.length+51)
  expect(plan.oldWaterToNew[plan.oldPooledBody]).toBeNull()
  expect(original.water.reduce((s,w)=>s+w.volume_m3,0)).toBeCloseTo(p.network.water.reduce((s,w)=>s+w.volume_m3,0),10)
  expect(original.water.reduce((s,w)=>s+w.moment_m4,0)).toBeCloseTo(p.network.water.reduce((s,w)=>s+w.volume_m3*w.elevation_m,0),10)
  const actual=new Map(plan.passiveRows.map((r,i)=>[r.stock+'/'+r.region,original.source.passiveVolumes[i]!]))
  for(const r of passive.nativeBulk.incidence)expect(actual.get(r.stock+'/'+r.region)).toBeCloseTo(r.volume,12)
  const cylinderActual=new Map(plan.cylinderRows.map((r,i)=>[r.target+'/'+r.region,original.source.cylinderShares[i]!]))
  for(const r of cylinder.intersections)expect(cylinderActual.get(r.target+'/'+r.region)).toBeCloseTo(r.share,11)
  expect(plan.immutable.stockIds).toEqual(passive.stocks.map(s=>s.id))
  expect(plan.immutable.targetIds).toEqual(cylinder.targets.map(t=>t.id))
  for(const cell of plan.guideCells){
   const rows=plan.waterRows.map((r,i)=>({r,i})).filter(q=>q.r.cell===cell)
   expect(rows.reduce((s,q)=>s+original.source.moderatorVolumes[q.i]!,0)).toBeCloseTo(original.water[cell]!.volume_m3,12)
   expect(rows.reduce((s,q)=>s+original.source.moderatorVolumes[q.i]!/original.source.externalWaterVolumes[cell]!,0)).toBeCloseTo(1,12)
  }
 })
 test('synthetic nonuniform current consumers change without touching any physical history',()=>{
  const before=JSON.stringify([passive.stocks,p.material.result,cylinder.targets,p.absorberGuide.hosts]),
   achieved=poses.map((p,i)=>({...p,body_y_m:.003998758851694222*(i+1)/52,
    stem_y_m:.003998758851694222*(53-i)/52,contact:'offseat' as const})),current=controlSourceMotionAt(plan,achieved)
  for(const field of ['passiveVolumes','cylinderShares','moderatorVolumes','externalWaterVolumes'] as const)
   expect(current.source[field]).not.toEqual(original.source[field])
  expect(current.contacts).not.toEqual(original.contacts)
  expect(current.mobile.path_shares).not.toEqual(original.mobile.path_shares)
  expect(current.mobile.liquid_chords_m).not.toEqual(original.mobile.liquid_chords_m)
  expect(current.water).not.toEqual(original.water)
  expect(JSON.stringify([passive.stocks,p.material.result,cylinder.targets,p.absorberGuide.hosts])).toBe(before)
  expect(controlSourceMotionAt(plan,poses)).toEqual(original)
  expect(current.water.reduce((s,w)=>s+w.volume_m3,0)).toBeCloseTo(original.water.reduce((s,w)=>s+w.volume_m3,0),10)
  for(let target=0;target<53;target++)expect(plan.cylinderRows.reduce((s,r,i)=>s+(r.target===target?current.source.cylinderShares[i]!:0),0)).toBeCloseTo(1,12)
  for(const [cluster,cell]of plan.guideCells.entries()){
   const body=plan.contactPlans.map((q,i)=>({q,i})).filter(q=>q.q.cluster===cluster&&q.q.role!=='fixed'),
    A=body.reduce((s,q)=>s+current.contacts[q.i]!.area_m2,0)
   expect(A).toBeCloseTo(plan.d.control.rodletsPerCluster*2*Math.PI*(plan.d.control.bodyDiameter_m/2)
    *plan.d.control.bodyLength_m+2*plan.bodyA,12)
   expect(plan.waterRows.reduce((s,r,i)=>s+(r.cell===cell?current.source.moderatorVolumes[i]!:0),0)).toBeCloseTo(current.water[cell]!.volume_m3,12)
  }
 })
 test('one fixed clipping/contact branch supplies analytic directions for every affected consumer',()=>{
  const interior=poses.map((p,i)=>({...p,body_y_m:.003+.00001*i,stem_y_m:.0034+.000005*i,contact:'offseat' as const})),
   directions=poses.map((_,i)=>({body:(i%3-1)*.03,stem:(i%5-2)*.01})),h=1e-5,
   value=controlSourceMotionAt(plan,interior,directions),
   plus=controlSourceMotionAt(plan,interior.map((p,i)=>({...p,body_y_m:p.body_y_m+h*directions[i]!.body,
    stem_y_m:p.stem_y_m+h*directions[i]!.stem}))),
   minus=controlSourceMotionAt(plan,interior.map((p,i)=>({...p,body_y_m:p.body_y_m-h*directions[i]!.body,
    stem_y_m:p.stem_y_m-h*directions[i]!.stem})))
  const compare=(a:number[],b:number[],derivative:number[])=>{
   expect(a.length).toBe(derivative.length)
   for(let i=0;i<a.length;i++){
    const actual=(a[i]!-b[i]!)/(2*h),expected=derivative[i]!,scale=Math.max(1e-9,Math.abs(actual),Math.abs(expected))
    expect(Math.abs(actual-expected)).toBeLessThan(3e-5*scale+2e-8)
   }
  }
  for(const field of ['passiveVolumes','cylinderShares','moderatorVolumes','externalWaterVolumes'] as const)
   compare(plus.source[field],minus.source[field],value.sourceDirection[field])
  for(const field of ['birth_shares','liquid_chords_m','path_shares','wall_thicknesses_m','boundary_shares'] as const)
   compare(plus.mobile[field],minus.mobile[field],value.mobileDirection[field])
  for(const frame of [value,plus,minus])for(const field of ['birth_shares','path_shares','boundary_shares'] as const)
   expect(frame.mobile[field].every(v=>v>=0&&v<=1)).toBe(true)
  for(const field of ['area_m2','solid_geometry_m_inv','liquid_chord_m'] as const)
   compare(plus.contacts.map(q=>q[field]),minus.contacts.map(q=>q[field]),value.contactDirection.map(q=>q[field]))
  for(const field of ['volume_m3','moment_m4'] as const)
   compare(plus.water.map(q=>q[field]),minus.water.map(q=>q[field]),value.waterDirection.map(q=>q[field]))
 })
 test('seated and offseat boundary are explicit and preserve identical volume while changing real contact topology',()=>{
  const off=controlSourceMotionAt(plan,poses.map(p=>({...p,contact:'offseat'}))),
   lower=plan.contactPlans.findIndex(q=>q.role==='bottom-lower'),guide=plan.contactPlans.findIndex(q=>q.role==='bottom-guide')
  expect(off.water).toEqual(original.water)
  expect(original.contacts[lower]!.area_m2).toBe(plan.bodyA)
  expect(original.contacts[guide]!.area_m2).toBe(0)
  expect(off.contacts[lower]!.area_m2).toBe(0)
  expect(off.contacts[guide]!.area_m2).toBe(plan.bodyA)
  expect(off.envelope.find(e=>e.id===plan.guideIds[0])!.boundary_m2-
   original.envelope.find(e=>e.id===plan.guideIds[0])!.boundary_m2).toBeCloseTo(2*plan.bodyA,12)
 })
 test('malformed identities, ambiguous state, unmodeled passages and missing directions refuse',()=>{
  for(const changed of [poses.slice(1),[poses[1]!,poses[0]!,...poses.slice(2)],
   poses.map((p,i)=>i? p:{...p,body_y_m:.001}),poses.map((p,i)=>i?p:{...p,body_y_m:plan.maximumBodyPose_m+.001,contact:'offseat' as const}),
   poses.map((p,i)=>i?p:{...p,stem_y_m:NaN}),poses.map((p,i)=>i?p:{...p,stem_y_m:-1})])
   expect(()=>controlSourceMotionAt(plan,changed)).toThrow()
  expect(()=>controlSourceMotionAt(plan,poses,[])).toThrow()
 })
 test('native stage frame retains complete value/direction shape and selected material photon laws',()=>{
  const fields=nativeControlSourceStage(original),half=(fields:number[],start:number)=>{
   let index=start
   const array=()=>{const n=fields[index++]!;const values=fields.slice(index,index+n);index+=n;return values},
    source=Array.from({length:3},array),contacts=fields[index++]!,contact=fields.slice(index,index+3*contacts)
   index+=3*contacts
   const mobile=Array.from({length:5},array),water=fields[index++]!,liquid=fields.slice(index,index+2*water)
   index+=2*water
   return {source,contacts,contact,mobile,water,liquid,index}
  },value=half(fields,0),direction=half(fields,value.index)
  expect(value.source.map(a=>a.length)).toEqual([plan.passiveRows.length,plan.cylinderRows.length,plan.waterRows.length])
  expect(value.mobile.map(a=>a.length)).toEqual([plan.routes.length,plan.routes.length,
   plan.origins.reduce((n,o)=>n+o.paths.length,0),plan.origins.reduce((n,o)=>n+o.paths.reduce((n,p)=>n+p.stages.length,0),0),plan.origins.length])
  expect(value.contacts).toBe(plan.contactPlans.length);expect(value.water).toBe(plan.water.length)
  expect(direction.index).toBe(fields.length)
  expect([...direction.source.flat(),...direction.contact,...direction.mobile.flat(),...direction.liquid].every(v=>v===0)).toBe(true)
  const expected=p.mobileCapture.wall_origins.flatMap(o=>o.paths).flatMap(p=>p.stages).find(s=>s.kind===2
   &&p.absorberGuide.hosts[s.recipient_index]?.kind==='guide')!.mu
  for(const o of plan.origins.filter(o=>o.kind==='guide'))for(const path of o.paths.filter(p=>p.role.kind==='fixed'))
   expect(path.stages[0]!.mu).toEqual(expected)
  expect(()=>nativeControlSourceStage({...original,source:{...original.source,cylinderShares:[NaN]}})).toThrow('Nonfinite')
  for(const bad of [-Number.MIN_VALUE,1+Number.EPSILON]){
   expect(()=>nativeControlSourceStage({...original,mobile:{...original.mobile,boundary_shares:[bad]}})).toThrow('[0,1]')
   expect(()=>nativeControlSourceStage({...original,mobile:{...original.mobile,path_shares:[bad]}})).toThrow('[0,1]')
  }
  expect(()=>nativeControlSourceStage({...original,source:{...original.source,externalWaterVolumes:[1]}})).toThrow('authority')
 })
 test('two original compile paths must agree on every retained physical identity and fuel cohort',()=>{
  const identities={regions:[...plan.immutable.regionIds],cohorts:p.material.result.cohorts.filter(c=>c.material==='fuel').map(c=>c.id)},
   payload={passive:{stocks:plan.immutable.stockIds.map(id=>({id}))},cylinder:{targets:plan.immutable.targetIds.map(id=>({id}))}}
  for(const mutate of [()=>{identities.regions[0]='foreign'},()=>{identities.cohorts[0]='foreign'},
   ()=>{payload.passive.stocks[0]!.id='foreign'},()=>{payload.cylinder.targets[0]!.id='foreign'}]){
   const prior=JSON.stringify([identities,payload]);mutate()
   // Deliberately truncated invalid input: the identity gate must refuse it
   // before reading any downstream preparation or serializing a numeric frame.
   const wrong={material:{nativeInputs:{fuel:{identities}},materialPayload:payload}} as unknown as Parameters<typeof nativeControlSourceFixture>[1]
   expect(()=>nativeControlSourceFixture(plan,wrong,p,[])).toThrow('physical identity/order')
   const [oldIds,oldPayload]=JSON.parse(prior);Object.assign(identities,oldIds);Object.assign(payload,oldPayload)
  }
 })
})
