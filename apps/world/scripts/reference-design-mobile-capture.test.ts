import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileMobileCapture,nativeMobileCaptureFrame,parseMobileCaptureSelection} from './reference-design-mobile-capture'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles,compilePrimaryWaterGeometry} from './reference-design-source-water'
import {fuelGeometry} from './reference-design-fuel-construction'

const selection={liquidProjection:'full-physical-origin-mean-chord',housingProjection:'equal-free-volume-full-span-annulus',
 wallProjection:'physical-origin-diffuse-contact-area',cladTraversal:'outer-to-inner-serial-shells',
 unrepresentedContact:'explicit-thermal-domain-boundary-export'} as const,block=(s:unknown)=>'```reference-mobile-capture-connection\n'+JSON.stringify(s)+'\n```'
test('mobile photon geometry is one inspectable selection without fallback or extra knobs',()=>{
 expect(parseMobileCaptureSelection(block(selection))).toEqual(selection)
 for(const text of ['',block(selection)+block(selection),block({...selection,extra:true}),
  block({...selection,wallProjection:'source-patch-contact'}),block({...selection,cladTraversal:'parallel'})])
  expect(()=>parseMobileCaptureSelection(text)).toThrow()
})
const wiki=process.env.LEITBILD_REFERENCE_WIKI,ownerTest=wiki?test:test.skip
let prepared:Promise<Awaited<ReturnType<typeof load>>>|undefined
async function load(){
 const p=await compileFuelCooling(wiki!),docs=await Promise.all(primaryWaterOwnerFiles.map(path=>Bun.file(join(wiki!,path)).text())),
  d=parsePrimaryWaterInputs(docs),geometry=compilePrimaryWaterGeometry(p.material.partition,d),
  text=await Bun.file(join(wiki!,'systems/reactor/configuration-source-and-history.md')).text()
 return {p,d,geometry,text}
}
const actual=()=>prepared??=load()

ownerTest('every physical birth is paid once while merged upper origins stay distinct',async()=>{
 const {p}=await actual(),c=p.mobileCapture
 for(const row of p.primary.rows){
  const own=c.routes.filter(r=>r.region===row.region&&r.water===row.cell)
  expect(own.reduce((s,r)=>s+r.birth_share,0)).toBeCloseTo(1,12)
 }
 const merged=c.routes.filter(r=>r.waterId==='UPPER')
 expect(new Set(merged.map(r=>r.origin))).toEqual(new Set(['UPPER.EXTERNAL','HOUSING.MAIN','HOUSING.NECK']))
 expect(new Set(merged.map(r=>r.wall_origin)).size).toBe(3)
 expect(new Set(merged.map(r=>r.liquid_chord_m)).size).toBe(3)
 for(const o of c.wall_origins)expect(o.unrepresented_wall_share+o.paths.reduce((s,p)=>s+p.share,0)).toBeCloseTo(1,14)
 expect(nativeMobileCaptureFrame(c).every(Number.isFinite)).toBe(true)
},60_000)

ownerTest('whole-core photon envelope ignores the numerical half-plane and wall map is not a Cartesian product',async()=>{
 const {p,d}=await actual(),c=p.mobileCapture,fg=fuelGeometry(d.fuel),L=d.fuel.activeLength_m,
  A=fg.wettedPerimeter_m*L+2*Math.PI*d.barrel.innerRadius_m*L+2*fg.flowArea_m2,
  core=c.envelopes.filter(e=>e.origin.startsWith('Core.')),
  routes=c.routes.filter(r=>r.origin.startsWith('Core.')),
  origins=new Set(routes.map(r=>r.wall_origin)),wall=c.wall_origins[[...origins][0]!]!
 expect(core).toHaveLength(2);expect(origins.size).toBe(1)
 for(const e of core){expect(e.volume_m3).toBeCloseTo(fg.flowArea_m2*L,12);expect(e.boundary_m2).toBeCloseTo(A,12)
  expect(e.chord_m).toBeCloseTo(4*fg.flowArea_m2*L/A,14)}
 expect(wall.paths).toHaveLength(p.thermal.bands.length+1+p.absorberGuide.hosts.filter(q=>q.kind==='guide'&&q.z0_m>=-2&&q.z1_m<=2).length)
 expect(wall.unrepresented_wall_share).toBeGreaterThan(0)
 const clad=wall.paths.filter(path=>path.stages[0]!.kind===0)
 for(const path of clad){
  expect(path.stages).toHaveLength(3)
  expect(path.stages[0]!.recipient_index).toBe(path.stages[1]!.recipient_index+1)
  expect(path.stages[1]!.recipient_index).toBe(path.stages[2]!.recipient_index+1)
  expect(path.stages.reduce((s,q)=>s+q.thickness_m,0)).toBeCloseTo(d.fuel.cladThickness_m,14)
 }
 expect(c.routes.every(r=>!('paths' in r))).toBe(true)
},60_000)

ownerTest('finite guide/BODY walls replace only matching boundary shares; housing remains explicit',async()=>{
 const {p}=await actual(),c=p.mobileCapture
 for(const e of c.envelopes){expect(e.chord_m).toBeCloseTo(4*e.volume_m3/e.boundary_m2,14)
  if(e.origin.startsWith('GUIDE.')||e.origin.startsWith('HOUSING.')){
   const route=c.routes.find(r=>r.origin===e.origin)!,o=c.wall_origins[route.wall_origin]!
   if(e.origin.startsWith('HOUSING.')){expect(o.paths).toHaveLength(0);expect(o.unrepresented_wall_share).toBe(1)}
   else {expect(o.paths.length).toBeGreaterThan(0);expect(o.unrepresented_wall_share).toBeGreaterThan(0)
    expect(o.unrepresented_wall_share).toBeLessThan(1)
    for(const path of o.paths)for(const stage of path.stages){expect(stage.kind).toBe(2)
     expect(stage.recipient_index).toBeLessThan(p.absorberGuide.hosts.length)}}
  }}
},60_000)

ownerTest('compiler rejects missing births, aliased owners and broken serial materials',async()=>{
 const {p,d,geometry,text}=await actual(),run=(primary=p.primary,thermal=p.thermal,material=p.material)=>
  compileMobileCapture(material,thermal,primary,d,geometry,p.barrel,p.absorberGuide,text)
 for(const birthPatches of [p.primary.birthPatches.slice(1),[...p.primary.birthPatches,p.primary.birthPatches[0]!],
  p.primary.birthPatches.map((r,i)=>i===0?{...r,origin:'unknown'}:r),
  p.primary.birthPatches.map((r,i)=>i===0?{...r,birth_share:r.birth_share/2}:r),
  p.primary.birthPatches.map((r,i)=>i===0?{...r,cellId:'other'}:r)])
  expect(()=>run({...p.primary,birthPatches})).toThrow()
 const cladId=p.thermal.bands[0]!.cohortIds.find(id=>id.includes('/clad/'))!
 expect(()=>run(p.primary,p.thermal,{...p.material,result:{...p.material.result,
  cohorts:p.material.result.cohorts.map(q=>q.id===cladId?{...q,inner_m:q.inner_m+1e-6}:q)}})).toThrow('clad')
 const reordered=run({...p.primary,birthPatches:[...p.primary.birthPatches].reverse()})
 expect(reordered.wall_origins).toEqual(p.mobileCapture.wall_origins)
 expect(reordered.envelopes).toEqual(p.mobileCapture.envelopes)
},60_000)
