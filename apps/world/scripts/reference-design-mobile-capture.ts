/** PRIMARY capture birth geometry, not a second emission/heat law. Liquid
 * self absorption stays at birth; shared diffuse wall paths run once/enclosure.
 * Numerical source cells cannot create new photon contact surfaces. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {parseCapturePhotonAbsorption} from './reference-design-converter-heat'
import {parsePassiveMaterialLaw} from './reference-design-source-passive'
import {fuelGeometry} from './reference-design-fuel-construction'
import {currentColdGeometry} from './reference-design-current-cold-parent'
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import type {compileFuelCoolingMaterial,compilePrimaryIncidence} from './reference-design-fuel-cooling'
import type {compileColdSourceMaterialOwners} from './reference-design-source-material'
import type {compileColdBarrel} from './reference-design-source-barrel'
import type {compilePrimaryWaterGeometry,parsePrimaryWaterInputs} from './reference-design-source-water'

const selectionSchema=z.object({
 liquidProjection:z.literal('full-physical-origin-mean-chord'),
 housingProjection:z.literal('equal-free-volume-full-span-annulus'),
 wallProjection:z.literal('physical-origin-diffuse-contact-area'),
 cladTraversal:z.literal('outer-to-inner-serial-shells'),
 unrepresentedContact:z.literal('explicit-thermal-domain-boundary-export'),
}).strict()
export function parseMobileCaptureSelection(text:string){
 return selectionSchema.parse(configurationBlock(text,'reference-mobile-capture-connection'))
}
type Material=ReturnType<typeof compileColdSourceMaterialOwners>
type Thermal=ReturnType<typeof compileFuelCoolingMaterial>
type Primary=ReturnType<typeof compilePrimaryIncidence>
type Water=ReturnType<typeof parsePrimaryWaterInputs>
type Geometry=ReturnType<typeof compilePrimaryWaterGeometry>
type Barrel=ReturnType<typeof compileColdBarrel>
type Stage={kind:0|1;recipient_index:number;thickness_m:number;density_kg_m3:number;mu:[number,number]}
type Path={share:number;stages:Stage[]}
const close=(a:number,b:number,label:string)=>{
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(a),Math.abs(b),1e-15))
  throw Error('Mobile capture physical incidence differs: '+label)
}

export function compileMobileCapture(material:Material,thermal:Thermal,primary:Primary,
 d:Water,geometry:Geometry,barrel:Barrel,text:string){
 const selection=parseMobileCaptureSelection(text),photon=parseCapturePhotonAbsorption(text),law=parsePassiveMaterialLaw(text),
  f=d.fuel,h=d.handling,c=d.control,current=currentColdGeometry(c,d.attachment,f,h,d.gates,d.head,d.cold),
  fg=fuelGeometry(f),cg=controlAbsorberGeometry(c,f,h),
  thermalRows=new Map(thermal.bands.flatMap(b=>b.cohortIds).map((id,i)=>[id,i])),
  cohorts=new Map(material.result.cohorts.map(q=>[q.id,{...q,row:thermalRows.get(q.id)}])),
  muSteel=photon.energies_MeV.map((_,j)=>law.steel304.massFractions.reduce((s,v,i)=>
   s+v*photon.mu_en_m2_kg[law.steel304.elements[i] as 'Fe'|'Cr'|'Ni'|'Mn'][j]!,0)) as [number,number],
  barrelStage:Stage={kind:1,recipient_index:0,thickness_m:d.barrel.outerRadius_m-d.barrel.innerRadius_m,
   density_kg_m3:barrel.steel_density_kg_m3,mu:muSteel},
  envelopes=new Map<string,{volume_m3:number;boundary_m2:number;chord_m:number;projection:string}>(barrel.contacts.map(q=>[q.owner,{volume_m3:q.photonVolume_m3,boundary_m2:q.photonBoundary_m2,
   chord_m:q.liquid_chord_m,projection:'selected-external-envelope'}])),
  wall_origins:{id:string;unrepresented_wall_share:number;paths:Path[]}[]=[],wallIndex=new Map<string,number>(),
  addWall=(id:string,paths:Path[])=>{
   const installed=paths.reduce((s,p)=>s+p.share,0)
   if(wallIndex.has(id)||!Number.isFinite(installed)||installed<0||installed>1)
    throw Error('Invalid complete mobile wall partition '+id)
   wallIndex.set(id,wall_origins.length);wall_origins.push({id,unrepresented_wall_share:1-installed,paths})
  },guideLength=current.faTop_m-h.seatedBottom_m
 const annulus=(origin:string,N:number,ro:number,ri:number,L:number,V:number,projection:string)=>{
  if(![N,ro,L,V].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(ri)||ri<0||!(ro>ri))
   throw Error('Invalid physical mobile capture envelope '+origin)
  close(V,N*Math.PI*(ro*ro-ri*ri)*L,origin+' complete volume')
  const A=N*2*Math.PI*(ro+ri)*L+2*V/L
  envelopes.set(origin,{volume_m3:V,boundary_m2:A,chord_m:4*V/A,projection});addWall(origin,[])
 }
 const coreV=fg.flowArea_m2*f.activeLength_m,
  coreBarrelArea=2*Math.PI*d.barrel.innerRadius_m*f.activeLength_m,
  coreA=fg.wettedPerimeter_m*f.activeLength_m+coreBarrelArea+2*fg.flowArea_m2,
  cladPaths:Path[]=thermal.bands.map(b=>{
   const clad=b.cohortIds.map(id=>cohorts.get(id)).filter(q=>q?.material==='clad')
   if(clad.length!==3||clad.some(q=>!q||q.row===undefined))throw Error('Incomplete actual mobile clad path '+b.id)
   close(clad[0]!.inner_m,f.rodOuterDiameter_m/2-f.cladThickness_m,b.id+' inner clad')
   let edge=clad[0]!.inner_m
   for(const q of clad){close(q!.inner_m,edge,b.id+' contiguous clad');edge=q!.outer_m
    close(q!.z1_m-q!.z0_m,b.length_m,b.id+' physical axial span')}
   close(edge,f.rodOuterDiameter_m/2,b.id+' outer clad')
   return {share:b.rods*Math.PI*f.rodOuterDiameter_m*b.length_m/coreA,
    stages:clad.reverse().map(q=>({kind:0,recipient_index:q!.row!,thickness_m:q!.outer_m-q!.inner_m,
     density_kg_m3:f.cladDensity_kg_m3,mu:[...photon.mu_en_m2_kg.Zr]}))}
  })
 close(thermal.bands.reduce((s,b)=>s+b.rods*b.length_m,0),f.assemblies*f.rodsPerAssembly*f.activeLength_m,'all rod wall area')
 addWall('ACTIVE.EXTERNAL',[...cladPaths,{share:coreBarrelArea/coreA,stages:[barrelStage]}])
 for(const origin of ['Core.1.EXTERNAL','Core.2.EXTERNAL'])envelopes.set(origin,{
  volume_m3:coreV,boundary_m2:coreA,chord_m:4*coreV/coreA,projection:'whole-active-core-external-water-including-barrel'})
 for(const contact of barrel.contacts.filter(q=>!q.owner.startsWith('Core.'))){
  const e=envelopes.get(contact.owner)!
  addWall(contact.owner,[{share:contact.area_m2/e.boundary_m2,stages:[barrelStage]}])
 }
 for(const [kind,ri,N]of [['EMPTY',0,f.assemblies*f.guidesPerAssembly-cg.rodlets-1],
  ['BODY',c.bodyDiameter_m/2,cg.rodlets],['THIMBLE',h.sourceThimbleDiameter_m/2,1]] as const){
  const cell=primary.cells.find(q=>q.id==='GUIDE.'+kind)
  if(!cell)throw Error('Missing dynamic guide recipient '+kind)
  annulus('GUIDE.'+kind,N,h.guideInnerDiameter_m/2,ri,guideLength,cell.totalVolume_m3,'actual-full-span-guide-annulus')
 }
 for(const [kind,ro,lo,hi]of [['MAIN',c.housingID_m/2,current.housing.mainLo,current.housing.mainHi],
  ['NECK',c.neckID_m/2,current.housing.mainHi,current.housing.neckHi]] as const){
  const origin='HOUSING.'+kind,V=geometry.pieces.filter(p=>p.owner===origin).reduce((s,p)=>s+p.volume_m3,0),L=hi-lo,
   ri2=ro*ro-V/(c.clusters*Math.PI*L)
  if(!(ri2>=0))throw Error('Housing free volume exceeds actual envelope '+origin)
  annulus(origin,c.clusters,ro,Math.sqrt(ri2),L,V,'effective-equal-free-volume-annulus')
 }
 const rows=new Map(primary.rows.map(r=>[r.region+'/'+r.cell,r])),seen=new Set<string>(),
  routes=primary.birthPatches.map(p=>{
   const key=p.region+'/'+p.cell,row=rows.get(key),envelope=envelopes.get(p.origin),
    wall_origin=wallIndex.get(p.origin.startsWith('Core.')?'ACTIVE.EXTERNAL':p.origin),patchKey=key+'/'+p.origin
   if(!row||seen.has(patchKey)||!envelope||wall_origin===undefined||!(p.volume_m3>0&&p.birth_share>0)
    ||p.cellId!==primary.cells[p.cell]?.id||p.sourceRegionId!==material.partition.regions[p.region]?.id)
    throw Error('Invalid/unknown/duplicated mobile birth origin '+p.origin)
   seen.add(patchKey);close(p.birth_share,p.volume_m3/row.volume_m3,'birth volume fraction')
   return {region:p.region,water:p.cell,birth_share:p.birth_share,liquid_chord_m:envelope.chord_m,wall_origin,
    origin:p.origin,sourceRegionId:p.sourceRegionId,waterId:p.cellId}
  })
 for(const row of primary.rows)close(routes.filter(r=>r.region===row.region&&r.water===row.cell)
  .reduce((s,r)=>s+r.birth_share,0),1,'complete region/native-water birth ownership')
 return {selection,water_mu:[...photon.mu_en_m2_kg.H2O] as [number,number],routes,wall_origins,
  envelopes:[...envelopes].map(([origin,e])=>({origin,...e})),
  scope:'PRIMARY H/B birth-site charged/liquid heat and diffuse physical-origin serial clad/barrel photons; separately retained unrepresented-contact thermal boundary. No local photon field, complete material closure or free-space escape claim.'}
}
export function nativeMobileCaptureFrame(input:ReturnType<typeof compileMobileCapture>){
 return [...input.water_mu,input.wall_origins.length,...input.wall_origins.flatMap(o=>[
  o.unrepresented_wall_share,o.paths.length,...o.paths.flatMap(p=>[p.share,p.stages.length,
   ...p.stages.flatMap(s=>[s.kind,s.recipient_index,s.thickness_m,s.density_kg_m3,...s.mu])])]),
 input.routes.length,...input.routes.flatMap(r=>[r.region,r.water,r.birth_share,r.liquid_chord_m,r.wall_origin])]
}
