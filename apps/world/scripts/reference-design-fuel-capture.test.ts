import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileFuelCapture,nativeFuelCaptureFrame,parseFuelCaptureSelection} from './reference-design-fuel-capture'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {parseCapturePhotonAbsorption} from './reference-design-converter-heat'

const selection={capturePhoton_MeV:[4.8063822,8.0871234,7.9867556],
 fuelPhotonBoundary:'full-active-column-side-and-two-ends',fuelSelfAllocation:'actual-intersection-fuel-mass',
 cladAllocation:'serial-physical-radial-control-volumes',liquidEnvelope:'existing-half-core-external-water',gapAbsorption:'uncredited'}
const block=(value:unknown)=>'```reference-fuel-capture-binding\n'+JSON.stringify(value)+'\n```'
test('fuel binding selection has one strict positive channel vector and no alternate projection',()=>{
 expect([...parseFuelCaptureSelection(block(selection)).capturePhoton_MeV]).toEqual(selection.capturePhoton_MeV)
 for(const doc of ['',block(selection)+block(selection),block({...selection,extra:1}),
  block({...selection,capturePhoton_MeV:[0,1,2]}),block({...selection,capturePhoton_MeV:[1,2]}),
  block({...selection,fuelSelfAllocation:'whole-segment'}),block({...selection,gapAbsorption:'all-local'})])
  expect(()=>parseFuelCaptureSelection(doc)).toThrow()
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,ownerTest=wiki?test:test.skip
let prepared:Promise<Awaited<ReturnType<typeof compileFuelCooling>>>|undefined
const apparatus=()=>prepared??=compileFuelCooling(wiki!)
ownerTest('actual whole rod chord and three Voronoi clad controls do not inherit source cuts',async()=>{
 const p=await apparatus(),c=p.capture,f=p.material.input.fuel,r=f.pelletDiameter_m/2,L=f.activeLength_m,
  text=await Bun.file(join(wiki!,'systems/reactor/configuration-source-and-history.md')).text(),
  photon=parseCapturePhotonAbsorption(text),selected=parseFuelCaptureSelection(text)
 expect(c.fuel_chord_m).toBe(4*c.hostVolume_m3/c.hostBoundary_m2)
 expect(c.fuel_chord_m).toBeCloseTo(2*r*L/(L+r),14)
 expect(c.fuel_chord_m).not.toBe(2*r*(L/2)/(L/2+r))
 expect([...c.capture_photon_j]).toEqual(selected.capturePhoton_MeV.map(q=>q*1.602176634e-13))
 expect(c.fuel_density_kg_m3).toBe(f.fuelDensityFraction*f.fuelTheoreticalDensity_kg_m3)
 expect(c.clad_density_kg_m3).toBe(f.cladDensity_kg_m3)
 expect(c.fuel_mu_en_m2_kg).toBe(photon.mu_en_m2_kg.UO2[1])
 expect(c.clad_mu_en_m2_kg).toBe(photon.mu_en_m2_kg.Zr[1])
 expect(c.liquid_mu_en_m2_kg).toBe(photon.mu_en_m2_kg.H2O[1])
 expect(c.bands).toHaveLength(p.thermal.bands.length)
 for(const b of c.bands){
  const t=p.thermal.bands[b.band_index]!,clad=t.cohortIds.map(id=>p.material.result.cohorts.find(q=>q.id===id)!)
   .filter(q=>q.material==='clad'),contact=p.barrel.contacts.find(q=>q.water_index===b.water_index)!
  expect([...b.clad_thickness_m]).toEqual(clad.map(q=>q.outer_m-q.inner_m))
  expect(b.clad_thickness_m.reduce((s,d)=>s+d,0)).toBeCloseTo(f.cladThickness_m,14)
  expect(b.clad_thickness_m[0]).toBeCloseTo(b.clad_thickness_m[1]/2,14)
  expect(b.clad_thickness_m[2]).toBeCloseTo(b.clad_thickness_m[1]/2,14)
  expect(p.network.water[b.water_index]!.id).toBe(b.water_id)
  expect(b.liquid_chord_m).toBe(contact.liquid_chord_m)
 }
 const changedPartition={...p.material,partition:{...p.material.partition,regions:[]}}
 expect(compileFuelCapture(changedPartition,p.thermal,p.network,p.barrel,text).fuel_chord_m).toBe(c.fuel_chord_m)
 const fields=nativeFuelCaptureFrame(c)
 expect(fields).toHaveLength(10+6*c.bands.length)
 expect(fields.slice(0,9)).toEqual([...c.capture_photon_j,c.fuel_chord_m,c.fuel_density_kg_m3,c.fuel_mu_en_m2_kg,
  c.clad_density_kg_m3,c.clad_mu_en_m2_kg,c.liquid_mu_en_m2_kg])
 expect(fields[9]).toBe(c.bands.length)
 expect(fields.every(Number.isFinite)).toBe(true)
},60_000)

ownerTest('serial clad optical depths telescope under shell splitting without a new rod chord',async()=>{
 const {capture:c}=await apparatus(),depth=c.clad_density_kg_m3*c.clad_mu_en_m2_kg,
  shells=c.bands[0]!.clad_thickness_m,whole=Math.exp(-depth*shells.reduce((s,d)=>s+d,0)),
  serial=shells.reduce((s,d)=>s*Math.exp(-depth*d),1),
  split=shells.flatMap(d=>[d/3,2*d/3]).reduce((s,d)=>s*Math.exp(-depth*d),1)
 expect(Math.abs(serial-whole)).toBeLessThanOrEqual(4*Number.EPSILON)
 expect(Math.abs(split-whole)).toBeLessThanOrEqual(8*Number.EPSILON)
 expect(whole).toBeGreaterThan(0);expect(whole).toBeLessThan(1)
})

ownerTest('fuel capture compiler refuses ambiguous controls, recipients and unrepresentable emission',async()=>{
 const p=await apparatus(),text=await Bun.file(join(wiki!,'systems/reactor/configuration-source-and-history.md')).text(),
  run=(material=p.material,thermal=p.thermal,network=p.network,barrel=p.barrel,source=text)=>
   compileFuelCapture(material,thermal,network,barrel,source)
 expect(()=>run(p.material,{...p.thermal,bands:[]})).toThrow('geometry')
 expect(()=>run(p.material,{...p.thermal,bands:[...p.thermal.bands,p.thermal.bands[0]!]})).toThrow('duplicated')
 expect(()=>run(p.material,p.thermal,p.network,{...p.barrel,contacts:p.barrel.contacts.filter(c=>c.cellId!=='CORE.1')}))
  .toThrow('recipient')
 expect(()=>run(p.material,p.thermal,p.network,{...p.barrel,contacts:[...p.barrel.contacts,p.barrel.contacts[1]!]}))
  .toThrow('recipient')
 expect(()=>run(p.material,p.thermal,{...p.network,water:[...p.network.water].reverse()})).toThrow('recipient')
 expect(()=>run(p.material,p.thermal,p.network,{...p.barrel,contacts:p.barrel.contacts.map(c=>
  c.cellId==='CORE.1'?{...c,liquid_chord_m:0}:c)})).toThrow('envelope')
 const cladId=p.thermal.bands[0]!.cohortIds.find(id=>id.includes('/clad/'))!,
  gap={...p.material,result:{...p.material.result,cohorts:p.material.result.cohorts.map(c=>
   c.id===cladId?{...c,inner_m:c.inner_m+1e-6}:c)}}
 expect(()=>run(gap)).toThrow('contiguous')
 expect(()=>run(p.material,{...p.thermal,bands:p.thermal.bands.map((b,i)=>i===0?{...b,length_m:b.length_m/2}:b)}))
  .toThrow('length')
 const tiny=text.replace(/"capturePhoton_MeV":\[[^\]]+\]/,'"capturePhoton_MeV":[5e-324,1,1]')
 expect(()=>run(p.material,p.thermal,p.network,p.barrel,tiny)).toThrow('Unrepresentable')
},60_000)
