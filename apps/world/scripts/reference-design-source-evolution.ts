/** Actual ORIGINAL source advancement input. Offline only; frozen thermal/pose
 * does not supply cooling, movement, detector acquisition or plant feedback. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {compileMaterialSourceCheck,materialSourceOwnerFiles} from './reference-design-source-transport-qualification'
import {compileFuelHistoryInputs,nativeFuelHistoryFixture} from './reference-design-fuel-history'
import {compilePrimaryWaterGeometry,parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import type {ReceivingLiquid} from './reference-design-source-receiving-water'

const nonnegative=z.number().finite().nonnegative(),positive=nonnegative.positive(),sha=(s:string)=>createHash('sha256').update(s).digest('hex'),
 amount=z.object({volume_m3:nonnegative,Htarget:nonnegative,HcaptureProduct:nonnegative,mobileN10:nonnegative}),
 primarySchema=z.object({passed:z.literal(true),inputs:z.unknown(),geometry:z.unknown(),result:z.object({
  nativeOwners:z.array(z.object({owner:z.string().min(1),total:amount,represented:amount,outsideSource:amount})).min(1),
  sourceIncidence:z.array(z.object({owner:z.string(),sourceRegionId:z.string(),amount}))})}),
 mnSchema=z.object({halfLife_s:positive,electron_MeV:nonnegative,photon_MeV:nonnegative,
  initialMn56:z.literal(0),initialFeProduct:z.literal(0)}).strict()
export const sourceEvolutionOwnerFiles=[...new Set([...primaryWaterOwnerFiles,...materialSourceOwnerFiles,
 'systems/reactor/fuel-handling-and-pool.md'])]
type WaterAmount=z.infer<typeof amount>
const close=(a:number,b:number,label:string)=>{
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(a),Math.abs(b),1e-20))throw Error('Water owner projection does not close: '+label)
}

/** One consumed composition per physical owner, never one donor per numerical
 * intersection. Source-outside inventory remains owned without source capture. */
export function compileSharedWaterProjection(primaryInput:unknown,receiving:ReturnType<typeof compileMaterialSourceCheck>['materialPayload']['receiving'],
 moderator:ReturnType<typeof compileMaterialSourceCheck>['nativeInputs']['moderator']){
 const p=primarySchema.parse(primaryInput),owners:{id:string,hydrogen:number,hydrogen_product:number,boron:number,boron_product:number}[]=[],
  ownerIndex=new Map<string,number>(),incidence=new Map<string,WaterAmount>()
 const add=(id:string,total:WaterAmount,represented:WaterAmount,outside:WaterAmount,boronProduct:number)=>{
  if(ownerIndex.has(id)||total.Htarget<=0)throw Error('Invalid/duplicated physical water owner '+id)
  for(const k of ['volume_m3','Htarget','HcaptureProduct','mobileN10'] as const)close(total[k],represented[k]+outside[k],id+' '+k)
  if(total.HcaptureProduct!==0||boronProduct!==0)throw Error('ORIGINAL water history must start at zero products')
  ownerIndex.set(id,owners.length);owners.push({id,hydrogen:total.Htarget,hydrogen_product:total.HcaptureProduct,
   boron:total.mobileN10,boron_product:boronProduct})
 }
 for(const q of p.result.nativeOwners)add(q.owner,q.total,q.represented,q.outsideSource,0)
 for(const q of receiving.nativeOwners){
  // These three complete selected receiving bays are all source-represented;
  // PRIMARY does not share this property (DOWN has unrepresented ends).
  add(q.owner,q.represented,q.represented,{volume_m3:0,Htarget:0,HcaptureProduct:0,mobileN10:0},q.represented.BcaptureProduct)
 }
 for(const q of [...p.result.sourceIncidence,...receiving.sourceIncidence]){
  const key=q.owner+'|'+q.sourceRegionId
  if(incidence.has(key)||!ownerIndex.has(q.owner))throw Error('Unknown/duplicated water source incidence '+key)
  incidence.set(key,q.amount)
 }
 if(moderator.identities.rows.length!==incidence.size)throw Error('Water projection incidence coverage mismatch')
 const used=new Set<string>(),sums=owners.map(()=>({H:0,B:0,volume:0})),rows=moderator.identities.rows.map((key,i)=>{
  const q=incidence.get(key),id=key.slice(0,key.indexOf('|')),owner=ownerIndex.get(id)
  if(!q||owner===undefined||used.has(key))throw Error('Unknown/duplicated moderator row '+key)
  used.add(key)
  const s=moderator.stocks[i]!,o=owners[owner]!
  close(s.hydrogen_target,q.Htarget,key+' hydrogen');close(s.mobile_boron10,q.mobileN10,key+' boron')
  close(s.liquid_volume,q.volume_m3,key+' volume');close(s.hydrogen_product,q.HcaptureProduct,key+' product')
  const H=q.Htarget/o.hydrogen,B=o.boron===0?0:q.mobileN10/o.boron
  if(H<0||H>1+4e-10||B<0||B>1+4e-10)throw Error('Water row exceeds physical donor')
  sums[owner]!.H+=q.Htarget;sums[owner]!.B+=q.mobileN10;sums[owner]!.volume+=q.volume_m3
  return {owner,h_fraction:H,b_fraction:B}
 })
 const represented=[...p.result.nativeOwners.map(q=>({id:q.owner,...q.represented})),...receiving.nativeOwners.map(q=>({id:q.owner,...q.represented}))]
 for(const q of represented){const s=sums[ownerIndex.get(q.id)!]!
  close(s.H,q.Htarget,q.id+' represented hydrogen');close(s.B,q.mobileN10,q.id+' represented boron');close(s.volume,q.volume_m3,q.id+' represented volume')}
 return {owners,rows,scope:'Uniform composition per total physical owner at fixed ORIGINAL mass/volume/temperature. Original row fractions are not renormalized; source-outside inventory is retained without invented capture. No advection or thermal advancement.'}
}

export function compileSourceEvolution(partitionText:string,materialText:string,waterText:string,documents:ReadonlyMap<string,string>,liquid:ReceivingLiquid){
 const read=(p:string)=>{const s=documents.get(p);if(s===undefined)throw Error('Missing source owner '+p);return s},
  water=primarySchema.parse(JSON.parse(waterText)),partition=JSON.parse(partitionText),
  waterInputs=parsePrimaryWaterInputs(primaryWaterOwnerFiles.map(read)),geometry=compilePrimaryWaterGeometry(partition.result,waterInputs)
 // Recompile semantic preparation, not whole-file prose hashes; never silently
 // reuse a qualified property field after its physical owner inputs changed.
 if(sha(JSON.stringify(waterInputs))!==sha(JSON.stringify(water.inputs))||sha(JSON.stringify(geometry))!==sha(JSON.stringify(water.geometry)))
  throw Error('Current ORIGINAL water preparation differs from admitted receipt')
 const material=compileMaterialSourceCheck(partitionText,materialText,waterText,[...primaryWaterOwnerFiles,...materialSourceOwnerFiles].map(read),liquid),
  history=compileFuelHistoryInputs(partition,JSON.parse(materialText),[
   'systems/reactor/configuration-source-and-history.md','systems/reactor/heat-and-history.md','systems/reactor/cold-source-and-startup.md',
   'systems/reactor/fuel-handling-and-pool.md','systems/instrumentation/nuclear-observation-apparatus.md'].map(read)),
  projection=compileSharedWaterProjection(JSON.parse(waterText),material.materialPayload.receiving,material.nativeInputs.moderator),
  mn=mnSchema.parse(configurationBlock(read('systems/reactor/configuration-source-and-history.md'),'reference-manganese-history')),
  manganese=material.nativeInputs.targets.flatMap((q,target)=>q.id.endsWith('/Mn')?[{target,decay_rate:Math.LN2/mn.halfLife_s,
   electron_j:mn.electron_MeV*1.602176634e-13,photon_j:mn.photon_MeV*1.602176634e-13}]:[])
 if(sha(JSON.stringify(history.fuel))!==sha(JSON.stringify(material.nativeInputs.fuel)))throw Error('Material/history fuel inputs differ')
 const framed=(s:string)=>{const words=s.trim().split(/\s+/);return [words.length,...words]},
  waterFields:(string|number)[]=[projection.owners.length,
   ...projection.owners.flatMap(o=>[o.hydrogen,o.hydrogen_product,o.boron,o.boron_product]),projection.rows.length,
   ...projection.rows.flatMap(q=>[q.owner,q.h_fraction,q.b_fraction])],
  mnFields=[manganese.length,...manganese.flatMap(q=>[q.target,q.decay_rate,q.electron_j,q.photon_j])],
  fields=[...framed(material.fixture),...framed(nativeFuelHistoryFixture(history)),
   ...framed(waterFields.join('\n')),...framed(mnFields.join('\n'))]
 return {fixture:fields.join('\n')+'\n',material,history,projection,manganese,
  counts:{...material.input.counts,physicalWaterOwners:projection.owners.length,manganeseOwners:manganese.length,
   evolvedCoordinates:history.counts.totalCoordinates+2*projection.owners.length+material.nativeInputs.targets.length+manganese.length},
  scope:'Represented seven-group source advancement from actual zero N/C/history and physical intrinsic/Cf births; frozen ORIGINAL geometry and temperature. Not a complete reactor, cooling model, calibrated source or installed plant.'}
}
