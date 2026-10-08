import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {parseAbsorberGuideSelection,parseB4CCaloric,nativeAbsorberGuideFrame,compileAbsorberGuide} from './reference-design-absorber-guide'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {b4cCaloric} from './reference-design-fuel-handling'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'

const selection={configuration:'fixed-original-seated-fully-liquid',
 bodyThermal:'one-composite-temperature-per-immutable-cluster',
 guideThermal:'one-radial-mean-per-FA-bore-cohort-and-native-axial-span',
 guideMeanRadius:'equal-volume-radius',guideConductance:'half-wall-cylindrical-resistance-at-mean-temperature',
 wetContact_W_m2_K:250,solidPhotonProjection:'full-physical-host-chord-and-contact-area',
 unrepresentedBoundary:'explicit-thermal-domain-export'} as const
const block=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```'
test('absorber/guide selection is explicit and refuses missing, duplicate, unknown and invalid fields',()=>{
 const text=block('reference-cold-absorber-guide-connection',selection)
 expect(parseAbsorberGuideSelection(text)).toEqual(selection)
 for(const bad of ['',text+text,block('reference-cold-absorber-guide-connection',{...selection,extra:1}),
  block('reference-cold-absorber-guide-connection',{...selection,configuration:'moving'}),
  block('reference-cold-absorber-guide-connection',{...selection,wetContact_W_m2_K:0}),
  text.replace('250','null'),'```reference-cold-absorber-guide-connection\n{\n```'])
  expect(()=>parseAbsorberGuideSelection(bad)).toThrow()
 for(const name of Object.keys(selection)){
  const bad:Record<string,unknown>={...selection};delete bad[name]
  expect(()=>parseAbsorberGuideSelection(block('reference-cold-absorber-guide-connection',bad))).toThrow()
 }
})
test('B4C caloric boundary refuses incomplete or inconsistent arrays and unsupported extras',()=>{
 const record={molarMass_kg_mol:.055255,datum_K:300,minimum_K:290,maximum_K:1600,
  temperature_K:[200,300,1600],cp_J_mol_K:[27.426,54.266,130.587]},name='reference-b4c-caloric',text=block(name,record)
 expect(parseB4CCaloric(text)).toEqual(record)
 for(const bad of ['',text+text,block(name,{...record,extra:true}),block(name,{...record,cp_J_mol_K:[1,2]}),
  block(name,{...record,temperature_K:[300,200,1600]}),block(name,{...record,minimum_K:199}),
  block(name,{...record,maximum_K:1700}),block(name,{...record,molarMass_kg_mol:0}),
  block(name,{...record,datum_K:1800}),block(name,{...record,cp_J_mol_K:[1,-2,3]})])
  expect(()=>parseB4CCaloric(bad)).toThrow()
 for(const key of Object.keys(record)){
  const bad:Record<string,unknown>={...record};delete bad[key]
  expect(()=>parseB4CCaloric(block(name,bad))).toThrow()
 }
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,evidence=process.env.LEITBILD_REFERENCE_EVIDENCE,
 ownerTest=wiki?test:test.skip,frameTest=wiki&&evidence?test:test.skip
let prepared:Promise<Awaited<ReturnType<typeof load>>>|undefined
async function load(){
 const p=await compileFuelCooling(wiki!),texts=await Promise.all(primaryWaterOwnerFiles.map(n=>Bun.file(join(wiki!,n)).text())),
  d=parsePrimaryWaterInputs(texts),pool=await Bun.file(join(wiki!,'systems/reactor/fuel-handling-and-pool.md')).text()
 return {p,d,caloric:parseB4CCaloric(pool)}
}
const actual=()=>prepared??=load(),sum=(values:readonly number[])=>values.reduce((s,v)=>s+v,0)

ownerTest('solid B4C photon composition is independent of dissolved primary boron isotope fraction',async()=>{
 const {p,d}=await actual(),read=(name:string)=>Bun.file(join(wiki!,name)).text(),
  [selectionText,caloricText,sourceText]=await Promise.all([
   read('systems/reactor/control-absorber-and-guide-water.md'),
   read('systems/reactor/fuel-handling-and-pool.md'),
   read('systems/reactor/configuration-source-and-history.md')]),
  changedWater={...d,chemistry:{...d.chemistry,isotopeFraction:.8}},
  changed=compileAbsorberGuide(changedWater,p.material,p.network,selectionText,caloricText,sourceText,p.barrel)
 expect(changedWater.chemistry.isotopeFraction).not.toBe(d.chemistry.isotopeFraction)
 expect(changed.photon.mu_b4c_05).toBe(p.absorberGuide.photon.mu_b4c_05)
 expect(changed.photon.mu_b4c_1).toBe(p.absorberGuide.photon.mu_b4c_1)
},60_000)

ownerTest('actual disjoint BODY and guide hosts preserve immutable identity, material and source-region volume',async()=>{
 const {p,d}=await actual(),hosts=p.absorberGuide.hosts,bodies=hosts.filter(h=>h.kind==='body'),guides=hosts.filter(h=>h.kind==='guide'),
  area=Math.PI*((d.fuel.guideOuterDiameter_m/2)**2-(d.handling.guideInnerDiameter_m/2)**2),
  length=d.control.bodyLength_m,expectedGuide=d.fuel.assemblies*d.fuel.guidesPerAssembly*area*length*d.fuel.cladDensity_kg_m3
 expect(bodies).toHaveLength(52);expect(guides).toHaveLength(984)
 expect(new Set(hosts.map(h=>h.id)).size).toBe(hosts.length)
 expect(new Set(bodies.map(h=>h.faId)).size).toBe(52)
 expect(bodies.map(h=>h.id)).toEqual(Array.from({length:52},(_,i)=>`LD01.CR.${String(i+1).padStart(3,'0')}/BODY`))
 expect(sum(guides.map(h=>h.zr_mass_kg))).toBeCloseTo(expectedGuide,7)
 expect(expectedGuide).toBeCloseTo(3213.7862055259484,7)
 expect(sum(bodies.map(h=>h.b4c_mass_kg))).toBeCloseTo(759.048997493,7)
 expect(sum(bodies.map(h=>h.steel_mass_kg))).toBeCloseTo(853.173229572,7)
 expect(guides.every(h=>h.b4c_mass_kg===0&&h.steel_mass_kg===0&&h.initial_k===300)).toBe(true)
 expect(bodies.every(h=>h.zr_mass_kg===0&&h.initial_k===d.cold.primaryMetalTemperature_K)).toBe(true)
 const regions=new Map<string,number>()
 for(const h of guides)for(const r of h.sourceShares){
  const key=h.stockId+'/'+r.sourceRegionId
  regions.set(key,(regions.get(key)??0)+r.volume_m3)
  expect(p.material.partition.regions[r.region]!.id).toBe(r.sourceRegionId)
 }
 const source=p.material.result.materialIncidence.filter(r=>r.kind==='guide-metal')
 expect(regions.size).toBe(source.length)
 for(const r of source)expect(regions.get(r.stockId+'/'+r.sourceRegionId)).toBeCloseTo(r.volume_m3,13)
 for(const link of p.absorberGuide.axialLinks){
  const a=hosts[link.a]!,b=hosts[link.b]!
  expect(a.kind).toBe('guide');expect(b.kind).toBe('guide');expect(a.faId).toBe(b.faId);expect(a.bore).toBe(b.bore)
  expect(a.z1_m).toBe(b.z0_m)
  expect(link.geometry_m).toBeCloseTo(a.tubes*area/((a.z1_m-a.z0_m+b.z1_m-b.z0_m)/2),14)
 }
},60_000)

ownerTest('true guide caps have axial thermal resistance and remain unrouted optical boundary',async()=>{
 const {p}=await actual(),b=p.absorberGuide,hosts=b.hosts,
  guide=hosts.filter(h=>h.kind==='guide'),bottom=Math.min(...guide.map(h=>h.z0_m)),top=Math.max(...guide.map(h=>h.z1_m))
 for(const h of guide){
  const area=h.tubes*Math.PI*(h.outer_m*h.outer_m-h.inner_m*h.inner_m),ends=h.contacts.filter(c=>c.surface==='end')
  expect(ends).toHaveLength(Number(h.z0_m===bottom)+Number(h.z1_m===top))
  for(const c of ends){expect(c.area_m2).toBeCloseTo(area,15)
   expect(c.solid_geometry_m_inv).toBeCloseTo((h.z1_m-h.z0_m)/(2*area),9)
   expect(['LOWER.EXTERNAL','UPPER.EXTERNAL']).toContain(c.origin)}
 }
 for(const origin of ['LOWER.EXTERNAL','UPPER.EXTERNAL']){
  const e=p.mobileCapture.envelopes.find(e=>e.origin===origin)!,old=p.barrel.contacts.find(c=>c.owner===origin)!,
   contact=hosts.flatMap(h=>h.contacts.filter(c=>c.origin===origin)),added=sum(contact.map(c=>c.area_m2)),
   wall=p.mobileCapture.wall_origins.find(w=>w.id===origin)!
  expect(e.volume_m3).toBe(old.photonVolume_m3)
  expect(e.boundary_m2).toBeCloseTo(old.photonBoundary_m2+added,10)
  expect(wall.unrepresented_wall_share+sum(wall.paths.map(p=>p.share))).toBeCloseTo(1,14)
  for(const [index,h]of hosts.entries())if(h.kind==='guide'){
   const actualPaths=wall.paths.filter(path=>path.stages.some(s=>s.kind===2&&s.recipient_index===index)),
    sides=h.contacts.filter(c=>c.origin===origin&&c.surface==='side')
   expect(actualPaths).toHaveLength(sides.length)
   expect(sum(actualPaths.map(path=>path.share))).toBeCloseTo(sum(sides.map(c=>c.area_m2))/e.boundary_m2,14)
  }
 }
},60_000)

ownerTest('consumed B4C Cp and primitive match the frozen helper throughout its admitted domain',async()=>{
 const {caloric:c}=await actual(),cp=(t:number)=>{
  const i=c.temperature_K.slice(1).findIndex(v=>t<=v),j=i<0?c.temperature_K.length-2:i
  return (c.cp_J_mol_K[j]!+(c.cp_J_mol_K[j+1]!-c.cp_J_mol_K[j]!)*
   (t-c.temperature_K[j]!)/(c.temperature_K[j+1]!-c.temperature_K[j]!))/c.molarMass_kg_mol
 },primitive=(a:number,b:number)=>{
  const points=[a,...c.temperature_K.filter(t=>t>a&&t<b),b]
  return sum(points.slice(1).map((t,i)=>(t-points[i]!)*(cp(t)+cp(points[i]!))/2))
 },points=[c.minimum_K,c.datum_K,c.maximum_K,...c.temperature_K.filter(t=>t>=c.minimum_K&&t<=c.maximum_K),
  ...c.temperature_K.slice(1).map((t,i)=>(t+c.temperature_K[i]!)/2).filter(t=>t>=c.minimum_K&&t<=c.maximum_K)]
 for(const t of points){const old=b4cCaloric(t,c.molarMass_kg_mol),e=t<c.datum_K?-primitive(t,c.datum_K):primitive(c.datum_K,t)
  expect(old.cp_J_kg_K).toBeCloseTo(cp(t),10);expect(old.e_J_kg).toBeCloseTo(e,7)}
 expect(b4cCaloric(c.datum_K,c.molarMass_kg_mol).e_J_kg).toBe(0)
 // The table's 200 K support knot is deliberately outside both selected domains.
 expect(()=>b4cCaloric(c.temperature_K[0]!,c.molarMass_kg_mol)).toThrow()
},60_000)

frameTest('actual source-native frame retains every region birth exactly once and all fields are finite',async()=>{
 const {p}=await actual(),read=(name:string)=>Bun.file(join(evidence!,name)).text(),
  documents=new Map(await Promise.all(sourceEvolutionOwnerFiles.map(async name=>[name,await Bun.file(join(wiki!,name)).text()] as const))),
  source=compileSourceEvolution(await read('2026-10-05/operating-source-fixed-partition.json'),
   await read('2026-10-05/operating-source-cold-material-incidence.json'),
   await read('2026-10-06/source-primary-original-water-coordinate-corrected.json'),documents,
   JSON.parse(await read('2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json')).receiving.property),
  frame=nativeAbsorberGuideFrame(p.absorberGuide,source,p.mobileCapture),sums=new Map<string,number>()
 expect(frame.fields.every(Number.isFinite)).toBe(true);expect(frame.bodies).toHaveLength(52)
 for(const row of frame.guideBirths){const key=row.target+'/'+row.region
  sums.set(key,(sums.get(key)??0)+row.share);expect(row.share).toBeGreaterThan(0)}
 const maximumShareExcess=Math.max(...frame.guideBirths.map(r=>r.share-1)),
  maximumRegionalSumDefect=Math.max(...[...sums.values()].map(v=>Math.abs(v-1)))
 expect(maximumShareExcess).toBeLessThanOrEqual(64*Number.EPSILON)
 expect(maximumRegionalSumDefect).toBeLessThanOrEqual(64*Number.EPSILON)
 console.info(JSON.stringify({kind:'absorber-guide-actual-frame-incidence',birthRows:frame.guideBirths.length,
  maximumShareExcess,maximumRegionalSumDefect}))
},60_000)
