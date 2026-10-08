/** Fixed ORIGINAL absorber/guide caloric and geometric incidence. Offline only:
 * these are existing disjoint material stocks, not added neutron targets. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import {fuelLatticeSites} from './reference-design-fuel-handling'
import {diskRectangleArea} from './reference-design-source-partition'
import {parsePassiveMaterialLaw} from './reference-design-source-passive'
import {parseCapturePhotonAbsorption} from './reference-design-converter-heat'
import type {compileColdBarrel} from './reference-design-source-barrel'
import type {compileSourceEvolution} from './reference-design-source-evolution'
import type {compileMobileCapture} from './reference-design-mobile-capture'
import type {compileColdSourceMaterialOwners} from './reference-design-source-material'
import type {parsePrimaryWaterInputs} from './reference-design-source-water'
import type {compileOperatingNetwork} from './reference-design-operating-network'

const positive=z.number().finite().positive()
const selectionSchema=z.object({configuration:z.literal('fixed-original-seated-fully-liquid'),
 bodyThermal:z.literal('one-composite-temperature-per-immutable-cluster'),
 guideThermal:z.literal('one-radial-mean-per-FA-bore-cohort-and-native-axial-span'),
 guideMeanRadius:z.literal('equal-volume-radius'),
 guideConductance:z.literal('half-wall-cylindrical-resistance-at-mean-temperature'),
 wetContact_W_m2_K:positive,
 solidPhotonProjection:z.literal('full-physical-host-chord-and-contact-area'),
 unrepresentedBoundary:z.literal('explicit-thermal-domain-export')}).strict()
const b4cSchema=z.object({molarMass_kg_mol:positive,datum_K:positive,minimum_K:positive,maximum_K:positive,
 temperature_K:z.array(positive).min(2),cp_J_mol_K:z.array(positive).min(2)}).strict().superRefine((q,ctx)=>{
 if(q.temperature_K.length!==q.cp_J_mol_K.length
  ||q.temperature_K.some((t,i)=>i>0&&t<=q.temperature_K[i-1]!)
  ||!(q.temperature_K[0]!<=q.minimum_K&&q.minimum_K<q.datum_K&&q.datum_K<q.maximum_K
    &&q.maximum_K<=q.temperature_K.at(-1)!))ctx.addIssue({code:'custom',message:'Invalid B4C caloric knots/domain/datum'})
})
export function parseAbsorberGuideSelection(text:string){
 return selectionSchema.parse(configurationBlock(text,'reference-cold-absorber-guide-connection'))
}
export function parseB4CCaloric(text:string){
 return b4cSchema.parse(configurationBlock(text,'reference-b4c-caloric'))
}

type Material=ReturnType<typeof compileColdSourceMaterialOwners>
type Water=ReturnType<typeof parsePrimaryWaterInputs>
type Network=Pick<Awaited<ReturnType<typeof compileOperatingNetwork>>,'water'>
export type AbsorberGuideContact={water:number;origin:string;surface:'side'|'end';area_m2:number;solid_geometry_m_inv:number}
export type AbsorberGuideHost={id:string;kind:'body'|'guide';stockId:string;faId:string;
 bore:'EMPTY'|'BODY'|'THIMBLE';z0_m:number;z1_m:number;tubes:number;
 steel_mass_kg:number;b4c_mass_kg:number;zr_mass_kg:number;initial_k:number;
 contacts:AbsorberGuideContact[];inner_m:number;outer_m:number;
 /** Whole physical material envelope, not numerical axial ends. */
 host_chord_m:number;
 sourceShares:{region:number;sourceRegionId:string;volume_m3:number}[]}
const close=(a:number,b:number,label:string)=>{
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(a),Math.abs(b),1e-15))
  throw Error('Absorber/guide incidence does not close: '+label)
}
export function compileAbsorberGuide(d:Water,material:Material,network:Network,selectionText:string,caloricText:string,
 sourceText:string,barrel:ReturnType<typeof compileColdBarrel>){
 const selection=parseAbsorberGuideSelection(selectionText),b4c=parseB4CCaloric(caloricText),
  {fuel:f,handling:h,control:c}=d,cg=controlAbsorberGeometry(c,f,h),
  bottom=h.seatedBottom_m,activeBottom=bottom+h.bottomFittingLength_m,activeTop=activeBottom+f.activeLength_m,
  top=activeTop+f.plenumLength_m+h.topFittingLength_m,gi=h.guideInnerDiameter_m/2,go=f.guideOuterDiameter_m/2,
  rm=Math.sqrt((gi*gi+go*go)/2),length=top-bottom,
  guides=fuelLatticeSites(f).filter(p=>p.guide),
  hostRows:AbsorberGuideHost[]=[],axialLinks:{a:number;b:number;geometry_m:number}[]=[],
  water=(id:string)=>{const i=network.water.findIndex(w=>w.id===id);if(i<0)throw Error('Missing absorber/guide liquid '+id);return i},
  span=[{lo:bottom,hi:activeBottom,id:'LOWER',origin:'LOWER.EXTERNAL'},
   {lo:activeBottom,hi:0,id:'CORE.1',origin:'Core.1.EXTERNAL'},
   {lo:0,hi:activeTop,id:'CORE.2',origin:'Core.2.EXTERNAL'},
   {lo:activeTop,hi:top,id:'UPPER',origin:'UPPER.EXTERNAL'}]
 if(!(bottom<activeBottom&&activeBottom<0&&0<activeTop&&activeTop<top&&go>gi))
  throw Error('Fixed ORIGINAL absorber/guide geometry no longer applies')
 close(c.insertedBodyBottom_m,bottom,'one seated bottom plane')
 close(c.insertedBodyBottom_m+c.bodyLength_m,top,'one FA/body top plane')
 close(c.insertedActiveBottom_m,activeBottom,'one active bottom plane')
 close(c.activeLength_m,f.activeLength_m,'one active material length')
 close(b4c.molarMass_kg_mol,h.b4cMolarMass_kg_mol,'B4C molecular mass')
 const clusterByFA=new Map<string,{site:typeof cg.sites[number];index:number}>()
 for(const [index,site]of cg.sites.entries()){
  const fa=material.partition.assemblies.find(fa=>fa.x_m===site.x_m&&fa.y_m===site.y_m)
  if(!fa||clusterByFA.has(fa.id))throw Error('Missing/duplicated immutable cluster assembly')
  clusterByFA.set(fa.id,{site,index})
  const stockId=`CONTROL/${site.x}/${site.y}`,N=c.rodletsPerCluster,
   shellVolume=cg.moving.bodySteel_kg/c.clusters/c.steelDensity_kg_m3,
   bodyArea=N*2*Math.PI*(c.bodyDiameter_m/2)*length,
   endArea=N*Math.PI*(c.bodyDiameter_m/2)**2
  hostRows.push({id:`LD01.CR.${String(index+1).padStart(3,'0')}/BODY`,kind:'body',stockId,faId:fa.id,bore:'BODY',
   z0_m:bottom,z1_m:top,tubes:N,steel_mass_kg:shellVolume*c.steelDensity_kg_m3,
   b4c_mass_kg:N*Math.PI*(c.absorberDiameter_m/2)**2*c.activeLength_m*c.b4cDensity_kg_m3,
   zr_mass_kg:0,initial_k:d.cold.primaryMetalTemperature_K,inner_m:c.absorberDiameter_m/2,outer_m:c.bodyDiameter_m/2,
   host_chord_m:4*shellVolume/(bodyArea+2*endArea
    +N*2*Math.PI*(c.absorberDiameter_m/2)*c.activeLength_m+N*2*Math.PI*(c.absorberDiameter_m/2)**2),sourceShares:[],
   contacts:[{water:water('GUIDE.BODY'),origin:'GUIDE.BODY',surface:'side',area_m2:bodyArea,solid_geometry_m_inv:0},
    {water:water('LOWER'),origin:'LOWER.EXTERNAL',surface:'end',area_m2:endArea,solid_geometry_m_inv:0},
    {water:water('UPPER'),origin:'UPPER.EXTERNAL',surface:'end',area_m2:endArea,solid_geometry_m_inv:0}]})
 }
 const annularArea=Math.PI*(go*go-gi*gi),wholeChord=4*annularArea*length/(2*Math.PI*(gi+go)*length+2*annularArea),
  regionRows=new Map<string,Material['result']['materialIncidence']>()
 for(const row of material.result.materialIncidence.filter(r=>r.kind==='guide-metal')){
  const rows=regionRows.get(row.faId)??[];rows.push(row);regionRows.set(row.faId,rows)
 }
 for(const fa of material.partition.assemblies){
  const cluster=clusterByFA.get(fa.id),byKind=new Map<'EMPTY'|'BODY'|'THIMBLE',typeof guides>()
  for(const pin of guides){
   const body=!!cluster&&cg.bodySites.some(q=>q.x_m===pin.x&&q.y_m===pin.y),
    thimble=fa.x_m+pin.x===0&&fa.y_m+pin.y===0
   if(body&&thimble)throw Error('Guide has two physical intruders')
   const kind=body?'BODY':thimble?'THIMBLE':'EMPTY',rows=byKind.get(kind)??[];rows.push(pin);byKind.set(kind,rows)
  }
  const stockId=fa.id+'/guide-metal',sourceTotals=new Map<string,number>(),
   actualSource=new Map((regionRows.get(fa.id)??[]).map(row=>[row.sourceRegionId,row.volume_m3]))
  for(const [bore,pins]of byKind){
   const rows:number[]=[]
   for(const s of span){
    const N=pins.length,L=s.hi-s.lo,A=N*annularArea,
     contacts:AbsorberGuideContact[]=[
      {water:water('GUIDE.'+bore),origin:'GUIDE.'+bore,surface:'side',area_m2:N*2*Math.PI*gi*L,solid_geometry_m_inv:Math.log(rm/gi)/(2*Math.PI*N*L)},
      {water:water(s.id),origin:s.origin,surface:'side',area_m2:N*2*Math.PI*go*L,solid_geometry_m_inv:Math.log(go/rm)/(2*Math.PI*N*L)}]
    if(s.lo===bottom)contacts.push({water:water('LOWER'),origin:'LOWER.EXTERNAL',surface:'end',area_m2:A,solid_geometry_m_inv:L/(2*A)})
    if(s.hi===top)contacts.push({water:water('UPPER'),origin:'UPPER.EXTERNAL',surface:'end',area_m2:A,solid_geometry_m_inv:L/(2*A)})
    const sourceShares:AbsorberGuideHost['sourceShares']=[]
    for(const [region,r]of material.partition.regions.entries()){
     const dz=r.compartment==='LOWER'?Math.max(0,Math.min(s.hi,activeBottom)-Math.max(s.lo,bottom)):
      r.compartment==='UPPER'?Math.max(0,Math.min(s.hi,top)-Math.max(s.lo,activeTop)):
      r.compartment==='ACTIVE'?Math.max(0,Math.min(s.hi,r.z1_m!)-Math.max(s.lo,r.z0_m!)):0
     if(dz===0)continue
     const circle=(pin:typeof guides[number],radius:number)=>{
      if(!r.box)return Math.PI*radius*radius
      const x=fa.x_m+pin.x,y=fa.y_m+pin.y,b=r.box
      if(b.x0>=x+radius||b.x1<=x-radius||b.y0>=y+radius||b.y1<=y-radius)return 0
      return diskRectangleArea(radius,{x0:b.x0-x,x1:b.x1-x,y0:b.y0-y,y1:b.y1-y})
     },V=pins.reduce((sum,pin)=>sum+circle(pin,go)-circle(pin,gi),0)*dz
     if(V<0||!Number.isFinite(V))throw Error('Invalid clipped guide cohort incidence')
     if(V>0){sourceShares.push({region,sourceRegionId:r.id,volume_m3:V});sourceTotals.set(r.id,(sourceTotals.get(r.id)??0)+V)}
    }
    rows.push(hostRows.length)
    hostRows.push({id:`${fa.id}/guide/${bore}/${s.id}`,kind:'guide',stockId,faId:fa.id,bore,z0_m:s.lo,z1_m:s.hi,tubes:N,
     steel_mass_kg:0,b4c_mass_kg:0,zr_mass_kg:A*L*f.cladDensity_kg_m3,
     initial_k:300,contacts,inner_m:gi,outer_m:go,host_chord_m:wholeChord,sourceShares})
   }
   for(let i=1;i<rows.length;i++){
    const a=rows[i-1]!,b=rows[i]!,left=hostRows[a]!,right=hostRows[b]!
    axialLinks.push({a,b,geometry_m:pins.length*annularArea/((left.z1_m-left.z0_m+right.z1_m-right.z0_m)/2)})
   }
  }
  if(actualSource.size!==sourceTotals.size)throw Error('Guide source region coverage differs '+fa.id)
  for(const [id,V]of actualSource)close(sourceTotals.get(id)??0,V,stockId+'/'+id)
  close(hostRows.filter(q=>q.stockId===stockId).reduce((sum,q)=>sum+q.zr_mass_kg,0),
   f.guidesPerAssembly*annularArea*length*f.cladDensity_kg_m3,stockId+' whole material')
 }
 if(new Set(hostRows.map(q=>q.id)).size!==hostRows.length)throw Error('Duplicated absorber/guide thermal owner')
 const law=parsePassiveMaterialLaw(sourceText),photon=parseCapturePhotonAbsorption(sourceText),
  bMass=4*(d.chemistry.isotope10MolarMass_kg_mol*law.B4C.B10AtomFraction
    +d.chemistry.isotope11MolarMass_kg_mol*(1-law.B4C.B10AtomFraction)),bShare=bMass/(bMass+.012011),
  steelMu=photon.energies_MeV.map((_,j)=>law.steel304.massFractions.reduce((sum,m,i)=>sum+m*
   photon.mu_en_m2_kg[law.steel304.elements[i] as 'Fe'|'Cr'|'Ni'|'Mn'][j]!,0)) as [number,number],
  photonInput={density_b4c:law.B4C.density,density_steel:law.steel304.density,density_zr:law.guideZr.density,
   mu_b4c_05:bShare*photon.mu_en_m2_kg.B[0]+(1-bShare)*photon.mu_en_m2_kg.C[0],
   mu_b4c_1:bShare*photon.mu_en_m2_kg.B[1]+(1-bShare)*photon.mu_en_m2_kg.C[1],
   mu_steel_05:steelMu[0],mu_steel_1:steelMu[1],mu_zr_1:photon.mu_en_m2_kg.Zr[1],
   mu_water_05:photon.mu_en_m2_kg.H2O[0],mu_water_1:photon.mu_en_m2_kg.H2O[1],
   guide_chord_m:wholeChord,guide_capture_j:law.zrBinding_J},
  caloric={steel_cp0:barrel.cp0_j_kg_k,steel_cp1:barrel.cp1_j_kg_k2,datum_k:barrel.datum_k,
   body_min_k:Math.max(barrel.minimum_k,b4c.minimum_K),body_max_k:Math.min(barrel.maximum_k,b4c.maximum_K),
   guide_min_k:290,guide_max_k:1800,b4c_cp_points:b4c.temperature_K.map((T,i)=>[T,b4c.cp_J_mol_K[i]!/b4c.molarMass_kg_mol])}
 close(c.b4cDensity_kg_m3,law.B4C.density,'B4C physical density')
 close(c.steelDensity_kg_m3,law.steel304.density,'304 physical density')
 close(f.cladDensity_kg_m3,law.guideZr.density,'Zr physical density')
 close(b4c.datum_K,caloric.datum_k,'shared caloric datum')
 return {selection,b4c,caloric,photon:photonInput,hosts:hostRows,axialLinks,
  scope:'Fixed ORIGINAL fully wet finite BODY composites and actual per-FA/bore/axial guide stocks; no motion, dry/hot qualification, spider/stem/head/jack installation or resolved gamma field.'}
}

export function nativeAbsorberGuideFrame(p:ReturnType<typeof compileAbsorberGuide>,source:ReturnType<typeof compileSourceEvolution>,
 mobile:ReturnType<typeof compileMobileCapture>){
 const {caloric:c,photon:g}=p,stocks=source.material.materialPayload.passive.stocks,
  stockById=new Map(stocks.map(q=>[q.id,q])),targets=source.material.nativeInputs.targets,
  targetIndex=new Map(targets.map((t,i)=>[t.id,i])),
  requireStock=(id:string)=>{const s=stockById.get(id);if(!s)throw Error('Missing absorber/guide source stock '+id);return s},
  target=(id:string)=>{const i=targetIndex.get(id);if(i===undefined)throw Error('Missing absorber/guide source target '+id);return i},
  contacts=p.hosts.flatMap((h,host)=>h.contacts.map(q=>{
   const e=mobile.envelopes.find(e=>e.origin===q.origin)
   if(!e||!(e.chord_m>0))throw Error('Missing absorber/guide photon liquid envelope '+q.origin)
   return {host,...q,liquid_chord_m:e.chord_m}
  })),
  bodies=p.hosts.flatMap((h,host)=>{
   if(h.kind!=='body')return []
   const b=requireStock(h.stockId+'/B4C'),s=requireStock(h.stockId+'/STEEL'),
    indices=[target(b.id+'/B10'),...['Fe','Cr','Ni','Mn'].map(e=>target(s.id+'/'+e))],
    mn=source.manganese.findIndex(m=>m.target===indices[4])
   close(b.mass_kg,h.b4c_mass_kg,h.id+' B4C capacity');close(s.mass_kg,h.steel_mass_kg,h.id+' 304 capacity')
   close(b.original_K,h.initial_k,h.id+' B4C preparation');close(s.original_K,h.initial_k,h.id+' 304 preparation')
   if(b.material!=='B4C'||s.material!=='steel304'||mn<0)throw Error('Wrong BODY material/Mn identity')
   const capture_j=indices.map(i=>targets[i]!.bindingEmission_J.reduce((sum,q)=>sum+q,0))
   // Derive active B4C length from its finite source volume, never a thermal band.
   const activeLength=b.volume_m3/(h.tubes*Math.PI*h.inner_m*h.inner_m),
    actualChord=2*h.inner_m*activeLength/(activeLength+h.inner_m)
   if(!Number.isFinite(actualChord)||actualChord<=0)throw Error('Invalid finite B4C envelope')
   return [{host,targets:indices,capture_j,b_photon_j:targets[indices[0]!]!.bindingEmission_J[1],mn_owner:mn,
    b4c_chord_m:actualChord,steel_chord_m:h.host_chord_m,steel_shell_m:h.outer_m-h.inner_m}]
  }),
  guideBirths:{target:number;region:number;host:number;share:number}[]=[],
  guideStockIds=new Set(p.hosts.filter(h=>h.kind==='guide').map(h=>h.stockId))
 for(const id of guideStockIds){
  const stock=requireStock(id),own=p.hosts.map((h,i)=>({h,i})).filter(q=>q.h.stockId===id),
   volumeRows=source.material.materialPayload.passive.volumeMaterial.filter(q=>q.stockId===id),
   regionVolumes=new Map(volumeRows.map(q=>[q.region,q.volume_m3]))
  if(stock.material!=='Zr'||stock.targets.length!==1)throw Error('Wrong guide material/target '+id)
  close(own.reduce((sum,q)=>sum+q.h.zr_mass_kg,0),stock.mass_kg,id+' finite capacity')
  const sums=new Map<number,number>(),ti=target(id+'/Zr')
  close(targets[ti]!.bindingEmission_J[1],g.guide_capture_j,id+' binding release')
  for(const {h,i}of own){
   close(h.initial_k,stock.original_K,id+' preparation')
   for(const r of h.sourceShares){
    const V=regionVolumes.get(r.region)
    if(!(V!==undefined&&V>0)||source.material.nativeInputs.fuel.identities.regions[r.region]!==r.sourceRegionId)
     throw Error('Unknown guide capture birth '+r.sourceRegionId)
    const share=r.volume_m3/V
    if(!(share>0&&share<=1+4e-10))throw Error('Invalid guide capture birth share')
    guideBirths.push({target:ti,region:r.region,host:i,share});sums.set(r.region,(sums.get(r.region)??0)+share)
   }
  }
  if(sums.size!==regionVolumes.size)throw Error('Missing guide source birth')
  for(const [region]of regionVolumes)close(sums.get(region)??0,1,id+'/'+region+' complete birth')
 }
 const fields=[c.steel_cp0,c.steel_cp1,c.datum_k,c.body_min_k,c.body_max_k,c.guide_min_k,c.guide_max_k,
  c.b4c_cp_points.length,...c.b4c_cp_points.flat(),p.selection.wetContact_W_m2_K,
  g.density_b4c,g.density_steel,g.density_zr,g.mu_b4c_05,g.mu_steel_05,g.mu_steel_1,g.mu_zr_1,
  g.mu_water_05,g.mu_water_1,g.guide_chord_m,g.guide_capture_j,
  p.hosts.length,...p.hosts.flatMap(h=>[h.b4c_mass_kg,h.steel_mass_kg,h.zr_mass_kg,h.initial_k]),
  contacts.length,...contacts.flatMap(q=>[q.host,q.water,q.area_m2,q.solid_geometry_m_inv,q.liquid_chord_m]),
  p.axialLinks.length,...p.axialLinks.flatMap(q=>[q.a,q.b,q.geometry_m]),
  bodies.length,...bodies.flatMap(q=>[q.host,...q.targets,...q.capture_j,q.b_photon_j,q.mn_owner,q.b4c_chord_m,q.steel_chord_m,q.steel_shell_m]),
  guideBirths.length,...guideBirths.flatMap(q=>[q.target,q.region,q.host,q.share])]
 if(fields.some(q=>!Number.isFinite(q)))throw Error('Nonfinite absorber/guide frame')
 return {fields,bodies,guideBirths,contacts}
}
