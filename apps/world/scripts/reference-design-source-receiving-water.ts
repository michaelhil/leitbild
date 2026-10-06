/** Actual ORIGINAL receiving bulk stocks, using native IF97 surface P/T and
 * exact displaced geometric moments. No primary H/S field, new hydrostatic
 * model, reached-state reset or imported CoolProp inventory. */
import {z} from 'zod'
const finite=z.number().finite(),positive=finite.positive(),nonnegative=finite.nonnegative()
const propertySchema=z.object({pressure_Pa:positive,temperature_K:positive,density_kg_m3:positive,u_J_kg:finite,h_J_kg:finite}).strict()
export type ReceivingLiquid=z.infer<typeof propertySchema>
export type ReceivingPiece={owner:string,sourceRegionId:string,volume_m3:number,momentZ_m4:number}
export function assembleReceivingWater(pieces:ReceivingPiece[],liquid:ReceivingLiquid,chemistry:{markerRatio:number,atomsPerMarker:number,avogadro:number}){
 const q=propertySchema.parse(liquid),c=z.object({markerRatio:nonnegative,atomsPerMarker:positive,avogadro:positive}).strict().parse(chemistry)
 if(pieces.length===0)throw Error('Missing actual receiving geometry')
 const seen=new Set<string>(),owners=new Map<string,{volume_m3:number,momentZ_m4:number,water_kg:number,U_J:number,PE_J:number,Htarget:number,HcaptureProduct:number,mobileN10:number,BcaptureProduct:number}>()
 const rows=pieces.map(p=>{
  if(!p.owner||!p.sourceRegionId||!Number.isFinite(p.volume_m3)||p.volume_m3<=0||!Number.isFinite(p.momentZ_m4))throw Error('Invalid receiving stock support')
  const key=p.owner+'|'+p.sourceRegionId
  if(seen.has(key))throw Error('Duplicated receiving stock incidence');seen.add(key)
  const M=q.density_kg_m3*p.volume_m3,amount={volume_m3:p.volume_m3,momentZ_m4:p.momentZ_m4,water_kg:M,U_J:M*q.u_J_kg,
   PE_J:q.density_kg_m3*9.80665*p.momentZ_m4,Htarget:2*M*c.avogadro/.01801528,HcaptureProduct:0,
   mobileN10:M*c.markerRatio*c.atomsPerMarker,BcaptureProduct:0}
  if(!Object.values(amount).every(Number.isFinite))throw Error('Nonfinite receiving stock')
  if(!owners.has(p.owner))owners.set(p.owner,{...amount,volume_m3:0,momentZ_m4:0,water_kg:0,U_J:0,PE_J:0,Htarget:0,HcaptureProduct:0,mobileN10:0,BcaptureProduct:0})
  const total=owners.get(p.owner)!
  for(const k of Object.keys(amount) as (keyof typeof amount)[])total[k]+=amount[k]
  return {owner:p.owner,sourceRegionId:p.sourceRegionId,amount}
 })
 return {preparation:'ORIGINAL receiving uniform-density native surface P/T',property:q,nativeOwners:[...owners].map(([owner,represented])=>({owner,represented})),sourceIncidence:rows,
  completeReactorOperator:false,scope:'Original receiving mass/energy/H/B10 inventories only. Uniform density at actual authored CNV surface P/T; pressure-head indication uses this same density. Not primary H/S equilibrium or native hydraulic advancement.'}
}
/** Caller owns the bounded preparation, source retention and binary identity. */
export async function sampleReceivingLiquid(binary:string,pressure_Pa:number,temperature_K:number,remainingMs:number){
 positive.parse(pressure_Pa);positive.parse(temperature_K);positive.parse(remainingMs)
 const child=Bun.spawn([binary],{stdin:new Blob([`1\n${pressure_Pa}\n${temperature_K}\n`]),stdout:'pipe',stderr:'pipe'});let timedOut=false
 const timer=setTimeout(()=>{timedOut=true;child.kill()},remainingMs)
 const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
 if(exitCode!==0||timedOut)throw Error('Receiving IF97 preparation refused: '+(timedOut?'aggregate allowance exhausted':stderr))
 const rows=stdout.trim().split('\n')
 if(rows.length!==1)throw Error('Receiving IF97 result coverage mismatch')
 const property=propertySchema.parse(JSON.parse(rows[0]!))
 if(property.pressure_Pa!==pressure_Pa||property.temperature_K!==temperature_K)throw Error('Receiving IF97 datum mismatch')
 return {property,stdout,stderr,exitCode}
}
