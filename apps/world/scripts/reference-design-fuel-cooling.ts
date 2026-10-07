/** Actual ORIGINAL cold radial/helium and primary SOURCE incidence. Offline
 * only. This compiles a join; it does not turn input compilation into a solved
 * trajectory or import old quadrature stocks into a point-lumped preparation. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {compileOperatingNetwork} from './reference-design-operating-network'
import {coldSourceMaterialOwnerFiles,compileColdSourceMaterialOwners} from './reference-design-source-material'
import {compilePrimaryWaterGeometry,primaryWaterOwnerFiles,parsePrimaryWaterInputs} from './reference-design-source-water'
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import {fuelLatticeSites} from './reference-design-fuel-handling'
import {fuelGeometry} from './reference-design-fuel-construction'
import {diskRectangleArea} from './reference-design-source-partition'
import {configurationBlock} from './reference-design-source-laws'
import {z} from 'zod'
import type {compileSourceEvolution} from './reference-design-source-evolution'
import {compileColdBarrel,nativeColdBarrelFrame} from './reference-design-source-barrel'
import {compileColdPressure,nativeColdPressureFrame} from './reference-design-cold-pressure-support'

type Network=Awaited<ReturnType<typeof compileOperatingNetwork>>
type Material=ReturnType<typeof compileColdSourceMaterialOwners>
type WaterInput=ReturnType<typeof parsePrimaryWaterInputs>
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const close=(a:number,b:number,label:string)=>{
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(a),Math.abs(b),1e-12))
  throw Error('Cold coupling incidence does not close: '+label)
}
const requireIndex=(map:Map<string,number>,id:string)=>{
 const i=map.get(id);if(i===undefined)throw Error('Missing coupled physical owner '+id);return i
}

const gapSchema=z.object({fuelEmissivity:z.number().finite().positive().max(1),
 cladEmissivity:z.number().finite().positive().max(1)}).strict()
export function parseOperatingFuelGap(document:string){return gapSchema.parse(configurationBlock(document,'reference-operating-fuel-gap'))}
const conditioningSchema=z.object({liquidTemperature_K:z.number().finite().positive()}).strict()
export function parseColdConditioningPreparation(document:string){
 return conditioningSchema.parse(configurationBlock(document,'reference-cold-conditioning-preparation'))
}
export function compileFuelCoolingMaterial(material:Material,network:Pick<Network,'water'|'hydraulic'>,gap:z.infer<typeof gapSchema>){
 const {result:r,input:{fuel:f,grid}}=material,waterIndexes=new Map(network.water.map((w,i)=>[w.id,i])),
  heliumIndexes=new Map(r.helium.map((h,i)=>[h.faId,i])),fg=fuelGeometry(f),
  bands:{id:string;fuel_radius_m:number;clad_inner_radius_m:number;clad_outer_radius_m:number;length_m:number;
   rods:number;fuel_masses_kg:number[];clad_masses_kg:number[];helium:number;water:number;
   flow_area_m2:number;hydraulic_diameter_m:number;fuel_emissivity:number;clad_emissivity:number;flowEdge:number;cohortIds:string[]}[]=[],
  cohortRows=new Map<string,number>()
 let next=0
 for(const h of r.helium)for(let band=0;band<grid.axialBands;band++){
  const own=r.cohorts.filter(c=>c.faId===h.faId&&c.band===band),fuel=own.filter(c=>c.material==='fuel').sort((a,b)=>a.node-b.node),
   clad=own.filter(c=>c.material==='clad').sort((a,b)=>a.node-b.node)
  if(fuel.length!==grid.fuelIntervals+1||clad.length!==grid.cladIntervals+1)throw Error('Incomplete radial material band')
  const lo=fuel[0]!.z0_m,hi=fuel[0]!.z1_m
  if(own.some(c=>c.z0_m!==lo||c.z1_m!==hi||c.original_K!==300))throw Error('Inconsistent cold material band')
  // These actual receiving half-core owners meet at the fixed material plane.
  // Refuse a band crossing it instead of choosing a recipient by its centroid.
  const core=hi<=0?'CORE.1':lo>=0?'CORE.2':undefined
  if(!core)throw Error('Thermal band crosses the native core-water boundary')
  const water=requireIndex(waterIndexes,core),incoming=network.hydraulic.map((e,i)=>({e,i})).filter(q=>q.e.to===water&&q.e.kind===3)
  if(incoming.length!==1)throw Error('Missing unique actual core sensible-film flow')
  const ids=[...fuel,...clad].map(c=>c.id)
  for(const id of ids){if(cohortRows.has(id))throw Error('Duplicated thermal energy owner');cohortRows.set(id,next++)}
  bands.push({id:`${h.faId}/thermal/${band}`,fuel_radius_m:f.pelletDiameter_m/2,
   clad_inner_radius_m:f.rodOuterDiameter_m/2-f.cladThickness_m,clad_outer_radius_m:f.rodOuterDiameter_m/2,
   length_m:hi-lo,rods:f.rodsPerAssembly,fuel_masses_kg:fuel.map(c=>c.referenceMass_kg),
   clad_masses_kg:clad.map(c=>c.referenceMass_kg),helium:requireIndex(heliumIndexes,h.faId),water,
   flow_area_m2:fg.flowArea_m2,hydraulic_diameter_m:fg.hydraulicDiameter_m,
   fuel_emissivity:gap.fuelEmissivity,clad_emissivity:gap.cladEmissivity,flowEdge:incoming[0]!.i,cohortIds:ids})
 }
 if(next!==r.cohorts.length)throw Error('Missing thermal cohort')
 const helium=r.helium.map(h=>({id:h.faId,volume_m3:h.volume_m3,nr_j_k:h.nR_J_K,
  accommodation:.425-2.3e-4*h.original_K,originalEnergy_J:h.originalInternalEnergy_J,row:next+requireIndex(heliumIndexes,h.faId)}))
 const fuelRows=r.cohorts.filter(c=>c.material==='fuel').map(c=>requireIndex(cohortRows,c.id)),
  originalTemperatures=[...r.cohorts.map(()=>300),...r.helium.map(h=>h.original_K)]
 close(bands.flatMap(b=>b.fuel_masses_kg).reduce((s,m)=>s+m,0),r.totals.fuelMass_kg,'fuel mass')
 return {bands,helium,fuelRows,originalTemperatures,thermalCoordinates:next+helium.length,
  scope:'Finite original fuel/clad and one common He owner per FA, actual core-water recipients; fixed prepared geometry, no phase or thermomechanical claim'}
}

/** Source intersection volume belongs to a CURRENT native liquid cell. Missing
 * representation is retained outsideSource; it is never normalized inward. */
export function compilePrimaryIncidence(network:Pick<Network,'water'>,partition:Material['partition'],d:WaterInput,
 geometry:ReturnType<typeof compilePrimaryWaterGeometry>){
 const indexes=new Map(network.water.map((w,i)=>[w.id,i])),
  regionIndexes=new Map(partition.regions.map((r,i)=>[r.id,i])),sums=new Map<string,number>(),expected=new Map<string,number>(),
  mapped=new Map<string,number>()
 const add=(region:string,cell:string,volume:number)=>{
  if(!Number.isFinite(volume)||volume<0)throw Error('Invalid primary source geometric support')
  if(volume===0)return
  const i=requireIndex(indexes,cell),r=requireIndex(regionIndexes,region),key=`${r}/${i}`
  mapped.set(key,(mapped.get(key)??0)+volume);sums.set(region,(sums.get(region)??0)+volume)
 }
 const external=new Map([['DOWN','DOWNCOMER'],['LOWER.EXTERNAL','LOWER'],['UPPER.EXTERNAL','UPPER'],
  ['Core.1.EXTERNAL','CORE.1'],['Core.2.EXTERNAL','CORE.2'],['HOUSING.MAIN','UPPER'],['HOUSING.NECK','UPPER']])
 for(const p of geometry.pieces){
  if(!p.sourceRegionId)continue
  expected.set(p.sourceRegionId,(expected.get(p.sourceRegionId)??0)+p.volume_m3)
  if(p.owner.endsWith('.GUIDE'))continue
  const cell=external.get(p.owner);if(!cell)throw Error('Unmapped physical primary support '+p.owner)
  add(p.sourceRegionId,cell,p.volume_m3)
 }
 const {fuel:f,handling:h,control:c}=d,cg=controlAbsorberGeometry(c,f,h),
  clusters=new Set(cg.sites.map(s=>`${s.x_m}/${s.y_m}`)),guides=fuelLatticeSites(f).filter(p=>p.guide),
  gi=h.guideInnerDiameter_m/2,body=c.bodyDiameter_m/2,thimble=h.sourceThimbleDiameter_m/2,
  bottom=h.seatedBottom_m,top=bottom+h.bottomFittingLength_m+f.activeLength_m+f.plenumLength_m+h.topFittingLength_m,
  bodyBottom=c.insertedBodyBottom_m,bodyTop=bodyBottom+c.bodyLength_m
 if(Math.abs(bodyBottom-bottom)>1e-14||Math.abs(bodyTop-top)>1e-14)throw Error('Current stationary guide-cohort reduction no longer applies')
 const sites=partition.assemblies.flatMap(fa=>guides.map(p=>{
  const isThimble=fa.x_m+p.x===0&&fa.y_m+p.y===0,
   isBody=clusters.has(`${fa.x_m}/${fa.y_m}`)&&cg.bodySites.some(b=>Math.abs(b.x_m-p.x)<1e-14&&Math.abs(b.y_m-p.y)<1e-14)
  if(isThimble&&isBody)throw Error('Duplicate guide intruder')
  return {x:fa.x_m+p.x,y:fa.y_m+p.y,kind:isThimble?'THIMBLE':isBody?'BODY':'EMPTY',inner:isThimble?thimble:isBody?body:0}
 }))
 const counts=new Map<string,number>();for(const s of sites)counts.set(s.kind,(counts.get(s.kind)??0)+1)
 if(counts.get('THIMBLE')!==1||counts.get('BODY')!==cg.rodlets)throw Error('Guide cohort site count mismatch')
 for(const r of partition.regions){
  if(!['ACTIVE','LOWER','UPPER'].includes(r.compartment))continue
  const activeBottom=bottom+h.bottomFittingLength_m,activeTop=activeBottom+f.activeLength_m,
   lo=r.compartment==='LOWER'?bottom:r.compartment==='UPPER'?activeTop:r.z0_m!,
   hi=r.compartment==='LOWER'?activeBottom:r.compartment==='UPPER'?top:r.z1_m!,length=Math.max(0,Math.min(top,hi)-Math.max(bottom,lo))
  if(length===0)continue
  const area=(s:typeof sites[number],radius:number)=>{
   if(radius===0)return 0
   if(!r.box)return Math.PI*radius**2
   if(r.box.x0>=s.x+radius||r.box.x1<=s.x-radius||r.box.y0>=s.y+radius||r.box.y1<=s.y-radius)return 0
   return diskRectangleArea(radius,{x0:r.box.x0-s.x,x1:r.box.x1-s.x,y0:r.box.y0-s.y,y1:r.box.y1-s.y})
  }
  const a=new Map<string,number>()
  for(const s of sites)a.set(s.kind,(a.get(s.kind)??0)+area(s,gi)-area(s,s.inner))
  for(const [kind,value]of a)add(r.id,'GUIDE.'+kind,value*length)
 }
 for(const [region,V]of expected)close(sums.get(region)??0,V,region+' source support')
 const represented=network.water.map(()=>0),rows=[...mapped].map(([key,volume_m3])=>{
  const [region,cell]=key.split('/').map(Number) as [number,number]
  represented[cell]!+=volume_m3
  return {region,sourceRegionId:partition.regions[region]!.id,cell,cellId:network.water[cell]!.id,volume_m3,
   volume_fraction:volume_m3/network.water[cell]!.volume_m3}
 }).sort((a,b)=>a.region-b.region||a.cell-b.cell)
 const cells=network.water.map((w,i)=>{
  const outside=w.volume_m3-represented[i]!
  if(outside< -4e-10*w.volume_m3)throw Error('Source support exceeds native physical cell '+w.id)
  return {id:w.id,representedVolume_m3:represented[i]!,outsideSourceVolume_m3:outside,totalVolume_m3:w.volume_m3}
 })
 return {rows,cells,hydrogenAtomsPerKg:2*geometry.avogadro/.01801528,
  boronAtomsPerKg:geometry.markerRatio*geometry.atomsPerMarker,markerRatio:geometry.markerRatio,
  preparation:'Fresh point-lumped native liquid stocks seed homogeneous reference carriers; NOT the separately qualified hydrostatic quadrature stocks',
  scope:'Exact original stationary geometric primary/source incidence; current mass/products are owned by native cells, closed receiving bays remain separate'}
}

/** Strict numeric frames for the offline native join; no parallel physical
 * description. The old source frame supplies unchanged non-water laws/history;
 * the reader REPLACES primary ownership/incidence, never retains its old rows. */
export function nativeFuelCoolingFixture(p:Awaited<ReturnType<typeof compileFuelCooling>>,
 source:ReturnType<typeof compileSourceEvolution>){
 const t=p.thermal,expected=p.material.result.cohorts.filter(c=>c.material==='fuel').map(c=>c.id),
  actual=source.material.nativeInputs.fuel.identities.cohorts
 if(expected.length!==actual.length||expected.some((id,i)=>id!==actual[i]))throw Error('Source/thermal cohort order differs')
 if(source.material.nativeInputs.fuel.identities.regions.some((id,i)=>id!==p.material.partition.regions[i]?.id)
  ||source.material.nativeInputs.fuel.identities.regions.length!==p.material.partition.regions.length)
  throw Error('Source/thermal spatial partition differs')
 const closed=source.material.materialPayload.receiving.nativeOwners.map(o=>{
  const i=source.projection.owners.findIndex(p=>p.id===o.owner)
  if(i<0)throw Error('Missing closed receiving water owner');return i
 })
 if(new Set(closed).size!==closed.length)throw Error('Duplicate closed receiving owner')
 const fields:number[]=[t.thermalCoordinates,t.bands.length,t.helium.length,t.fuelRows.length]
 for(const b of t.bands)fields.push(b.fuel_radius_m,b.clad_inner_radius_m,b.clad_outer_radius_m,b.length_m,b.rods,
  b.fuel_masses_kg.length,...b.fuel_masses_kg,b.clad_masses_kg.length,...b.clad_masses_kg,b.helium,b.water,
  b.flow_area_m2,b.hydraulic_diameter_m,b.fuel_emissivity,b.clad_emissivity)
 for(const h of t.helium)fields.push(h.volume_m3,h.nr_j_k,h.accommodation)
 const flows=p.network.water.map((_,i)=>{
  const edges=t.bands.filter(b=>b.water===i).map(b=>b.flowEdge)
  if(new Set(edges).size>1)throw Error('Ambiguous shared fuel-wall flow')
  return edges[0]??-1
 })
 fields.push(...t.originalTemperatures,...t.fuelRows,...flows)
 const primary=[p.network.water.length,p.primary.hydrogenAtomsPerKg,p.primary.boronAtomsPerKg,
  closed.length,...closed,p.primary.rows.length,
  ...p.primary.rows.flatMap(r=>[r.region,r.cell,r.volume_m3,r.volume_fraction])]
 const frame=(s:string)=>{const tokens=s.trim().split(/\s+/);return [tokens.length,...tokens].join('\n')}
 const barrel=nativeColdBarrelFrame(p.barrel,source)
 return [source.fixture,p.network.nativeInput,fields.join('\n'),primary.join('\n'),barrel.fields.join('\n'),
  nativeColdPressureFrame(p.pressure).join('\n')].map(frame).join('\n')+'\n'
}

export async function compileFuelCooling(wiki:string){
 const extra=['systems/reactor/phase-dependent-heat-transfer.md','systems/primary-coolant/heater-equipment.md',
  'systems/reactor/configuration-source-and-history.md','model/operating-pressure-support.md',
  'systems/primary-coolant/surge-route.md','model/operating-source-model.md'],names=[...new Set([...coldSourceMaterialOwnerFiles,...primaryWaterOwnerFiles,...extra])],
  texts=await Promise.all(names.map(p=>Bun.file(join(wiki,p)).text())),docs=new Map(names.map((p,i)=>[p,texts[i]!])),
  read=(p:string)=>{const s=docs.get(p);if(s===undefined)throw Error('Missing cold coupling owner '+p);return s},
  material=compileColdSourceMaterialOwners(coldSourceMaterialOwnerFiles.map(read)),
  conditioning=parseColdConditioningPreparation(read('model/operating-source-model.md')),
  network=await compileOperatingNetwork(wiki,{horizon_s:300,remainingBudget_s:120},{temperature_K:conditioning.liquidTemperature_K}),
  d=parsePrimaryWaterInputs(primaryWaterOwnerFiles.map(read)),thermal=compileFuelCoolingMaterial(material,network,parseOperatingFuelGap(read(extra[0]!))),
  geometry=compilePrimaryWaterGeometry(material.partition,d),
  primary=compilePrimaryIncidence(network,material.partition,d,geometry),
  barrel=compileColdBarrel(d,network,geometry,read('systems/reactor/configuration-source-and-history.md'),read(extra[1]!)),
  pressure=compileColdPressure(read('model/operating-pressure-support.md'),read('systems/primary-coolant/surge-route.md'),
   network.water,barrel,primary.boronAtomsPerKg/primary.markerRatio,conditioning.liquidTemperature_K),
  identities=names.map((name,i)=>({name,sha256:sha(texts[i]!)}))
 if(network.water.some(w=>w.markerRatio!==primary.markerRatio))throw Error('Connected primary preparation is not homogeneous')
 for(const identity of network.ownerIdentities){const same=identities.find(x=>x.name===identity.name)
  if(same&&same.sha256!==identity.sha256)throw Error('Owner changed across current coupling compilers')}
 if((await Promise.all(names.map(p=>Bun.file(join(wiki,p)).text()))).some((s,i)=>s!==texts[i]))throw Error('Owner changed during cold coupling compilation')
 return {thermal,primary,network,material,barrel,pressure,conditioning,ownerIdentities:identities,
  limitations:['Compilation is not an advancing coupled plant or empirical qualification',
   'Cold fully wet primary, fixed prepared fuel/guide geometry; no primary phase continuation, motion or coastdown',
   'Finite mixed surge and cold separated liquid/steam/air PZR; no hot pressure regulation, resolved thermal fronts or dryout',
   'BARREL prompt/Mn emissions join its finite 304 owner and five actual primary recipients, with explicit photon export',
   'Other nonfuel/Cf/particle/capture heat recipients remain separately unjoined, not invented exports',
   'Old hydrostatic source-stock receipt does not define the new point-lumped coupled preparation']}
}
