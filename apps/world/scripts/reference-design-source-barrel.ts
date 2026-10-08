/** Selected cold BARREL physical input. This is one finite recipient, not a
 * generic source-to-heat registry or a second primary-water preparation. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {parsePassiveMaterialLaw} from './reference-design-source-passive'
import {parseCapturePhotonAbsorption} from './reference-design-converter-heat'
import type {compilePrimaryWaterGeometry, parsePrimaryWaterInputs} from './reference-design-source-water'
import {fuelGeometry} from './reference-design-fuel-construction'
import type {compileOperatingNetwork} from './reference-design-operating-network'
import type {compileSourceEvolution} from './reference-design-source-evolution'

const positive=z.number().finite().positive()
const caloricSchema=z.object({density_kg_m3:positive,cpConstant_J_kg_K:positive,cpLinear_J_kg_K2:positive,
 datum_K:positive,minimum_K:positive,maximum_K:positive}).strict()
 .refine(q=>q.minimum_K<q.datum_K&&q.datum_K<q.maximum_K,'Invalid caloric domain/datum')
const selectionSchema=z.object({wetContact_W_m2_K:positive,
 hostPhotonBoundary:z.literal('both-cylinders-and-annular-ends'),
 photonContactWeights:z.literal('normalized-five-thermal-areas'),liquidEnvelopes:z.object({
  'LOWER.EXTERNAL':z.object({kind:z.literal('reduced-cylinder'),radius_m:positive}).strict(),
  'Core.1.EXTERNAL':z.object({kind:z.literal('rod-guide-exterior-and-two-liquid-ends'),length_m:positive}).strict(),
  'Core.2.EXTERNAL':z.object({kind:z.literal('rod-guide-exterior-and-two-liquid-ends'),length_m:positive}).strict(),
  'UPPER.EXTERNAL':z.object({kind:z.literal('reduced-cylinder'),crossSection_m2:positive}).strict(),
  DOWN:z.object({kind:z.literal('owned-annulus'),innerRadius_m:positive,length_m:positive}).strict(),
 }).strict()}).strict()
/** One current typed 304 caloric owner, shared by all finite recipients. */
export function parse304Caloric(document:string){
 return caloricSchema.parse(configurationBlock(document,'reference-304-caloric'))
}
export function parseColdBarrelSelection(source:string,caloric:string){
 return {selection:selectionSchema.parse(configurationBlock(source,'reference-cold-barrel-connection')),
  caloric:parse304Caloric(caloric)}
}
type Network=Pick<Awaited<ReturnType<typeof compileOperatingNetwork>>,'water'>
type WaterInput=ReturnType<typeof parsePrimaryWaterInputs>
const close=(a:number,b:number,label:string)=>{
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(a),Math.abs(b),1e-15))
  throw Error('Cold barrel physical incidence differs: '+label)
}
export function compileColdBarrel(d:WaterInput,network:Network,geometry:ReturnType<typeof compilePrimaryWaterGeometry>,
 sourceText:string,caloricText:string){
 const {selection:s,caloric:c}=parseColdBarrelSelection(sourceText,caloricText),
  law=parsePassiveMaterialLaw(sourceText),photon=parseCapturePhotonAbsorption(sourceText),
  fg=fuelGeometry(d.fuel),
  ri=d.barrel.innerRadius_m,ro=d.barrel.outerRadius_m,
  bottom=d.primary.downcomerBottom_m,top=d.primary.downcomerTop_m,length=top-bottom,
  coreBottom=-d.fuel.activeLength_m/2,coreTop=d.fuel.activeLength_m/2,
  volume=Math.PI*(ro-ri)*(ro+ri)*length,
  hostBoundary=2*Math.PI*(ri+ro)*length+2*Math.PI*(ro-ri)*(ro+ri)
 close(c.density_kg_m3,law.steel304.density,'304 density')
 close(s.liquidEnvelopes.DOWN.innerRadius_m,ro,'DOWN inner radius')
 close(s.liquidEnvelopes.DOWN.length_m,length,'DOWN physical length')
 if(!(bottom<coreBottom&&coreTop<top))throw Error('Barrel does not enclose selected core contact span')
 const volumeOf=(owner:string)=>{
  const rows=geometry.pieces.filter(p=>p.owner===owner),V=rows.reduce((sum,p)=>sum+p.volume_m3,0)
  if(!(V>0&&Number.isFinite(V)))throw Error('Missing barrel photon envelope '+owner)
  return V
 }
 const cylinderBoundary=(V:number,A:number)=>{
  const radius=Math.sqrt(A/Math.PI),height=V/A
  return 2*Math.PI*radius*height+2*A
 }
 const coreEnvelope=(owner:'Core.1.EXTERNAL'|'Core.2.EXTERNAL')=>{
  const V=volumeOf(owner),L=s.liquidEnvelopes[owner].length_m
  close(L,d.fuel.activeLength_m/2,owner+' physical half length')
  close(V,fg.flowArea_m2*L,owner+' free water')
  return {V,A:fg.wettedPerimeter_m*L+2*fg.flowArea_m2}
 }
 const lowerV=volumeOf('LOWER.EXTERNAL'),upperV=volumeOf('UPPER.EXTERNAL'),downV=volumeOf('DOWN'),
  downOuter=Math.sqrt(ro*ro+downV/(Math.PI*length)),
  envelope={
   'LOWER.EXTERNAL':{V:lowerV,A:cylinderBoundary(lowerV,Math.PI*s.liquidEnvelopes['LOWER.EXTERNAL'].radius_m**2)},
   'Core.1.EXTERNAL':coreEnvelope('Core.1.EXTERNAL'),
   'Core.2.EXTERNAL':coreEnvelope('Core.2.EXTERNAL'),
   'UPPER.EXTERNAL':{V:upperV,A:cylinderBoundary(upperV,s.liquidEnvelopes['UPPER.EXTERNAL'].crossSection_m2)},
   DOWN:{V:downV,A:2*Math.PI*(ro+downOuter)*length+2*downV/length},
  }
 const patches=[
  {owner:'LOWER.EXTERNAL',cell:'LOWER',area:2*Math.PI*ri*(coreBottom-bottom)},
  {owner:'Core.1.EXTERNAL',cell:'CORE.1',area:2*Math.PI*ri*(0-coreBottom)},
  {owner:'Core.2.EXTERNAL',cell:'CORE.2',area:2*Math.PI*ri*coreTop},
  {owner:'UPPER.EXTERNAL',cell:'UPPER',area:2*Math.PI*ri*(top-coreTop)},
  {owner:'DOWN',cell:'DOWNCOMER',area:2*Math.PI*ro*length},
 ] as const
 const contacts=patches.map(p=>{
  const cell=network.water.findIndex(w=>w.id===p.cell),e=envelope[p.owner]
  if(cell<0||!(p.area>0&&e.A>0&&Number.isFinite(e.A+e.V)))throw Error('Unresolved barrel receiving contact '+p.owner)
  if(e.V>network.water[cell]!.volume_m3*(1+4e-10))throw Error('Barrel photon envelope exceeds thermal recipient '+p.owner)
  return {owner:p.owner,cellId:p.cell,water_index:cell,area_m2:p.area,
   liquid_chord_m:4*e.V/e.A,photonVolume_m3:e.V,photonBoundary_m2:e.A}
 })
 const muSteel=law.steel304.massFractions.reduce((sum,f,i)=>sum+f*photon.mu_en_m2_kg[
  law.steel304.elements[i] as 'Fe'|'Cr'|'Ni'|'Mn'][1],0)
 return {mass_kg:volume*c.density_kg_m3,volume_m3:volume,hostBoundary_m2:hostBoundary,
  cp0_j_kg_k:c.cpConstant_J_kg_K,cp1_j_kg_k2:c.cpLinear_J_kg_K2,
  datum_k:c.datum_K,minimum_k:c.minimum_K,maximum_k:c.maximum_K,initial_temperature_k:c.datum_K,
  steel_density_kg_m3:c.density_kg_m3,host_chord_m:4*volume/hostBoundary,
  steel_mu_en_m2_kg:muSteel,liquid_mu_en_m2_kg:photon.mu_en_m2_kg.H2O[1],
  wet_h_w_m2_k:s.wetContact_W_m2_K,contacts,
  scope:'One finite ORIGINAL 304 barrel; selected full-wet cold photon envelopes and five reciprocal contacts. Other binding/activation recipients remain unjoined.'}
}

export function nativeColdBarrelFrame(b:ReturnType<typeof compileColdBarrel>,source:ReturnType<typeof compileSourceEvolution>){
 const stocks=source.material.materialPayload.passive.stocks.filter(s=>s.id==='BARREL')
 if(stocks.length!==1||stocks[0]!.material!=='steel304')throw Error('Missing unique source BARREL material')
 const stock=stocks[0]!
 close(stock.mass_kg,b.mass_kg,'source/thermal barrel mass');close(stock.volume_m3,b.volume_m3,'source/thermal barrel volume')
 close(stock.original_K,b.initial_temperature_k,'source/thermal barrel preparation')
 const elements=['Fe','Cr','Ni','Mn'],targets=elements.map(element=>{
  const id='BARREL/'+element,index=source.material.nativeInputs.targets.findIndex(t=>t.id===id),
   owned=stock.targets.filter(t=>t.id===id)
  if(index<0||owned.length!==1||owned[0]!.bindingEmission_J[0]!==0)throw Error('Invalid barrel capture class '+id)
  return {index,photon_j:owned[0]!.bindingEmission_J[1]}
 })
 const mn=source.manganese.findIndex(m=>m.target===targets[3]!.index)
 if(mn<0)throw Error('Missing barrel Mn history')
 return {targets,mn_owner_index:mn,
  fields:[b.mass_kg,b.cp0_j_kg_k,b.cp1_j_kg_k2,b.datum_k,b.minimum_k,b.maximum_k,b.initial_temperature_k,
   b.steel_density_kg_m3,b.host_chord_m,b.steel_mu_en_m2_kg,b.liquid_mu_en_m2_kg,b.wet_h_w_m2_k,
   ...targets.flatMap(t=>[t.index,t.photon_j]),mn,b.contacts.length,
   ...b.contacts.flatMap(c=>[c.water_index,c.area_m2,c.liquid_chord_m])]}
}
