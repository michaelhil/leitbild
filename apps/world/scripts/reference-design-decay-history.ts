/** Offline retained-energy verification; not a plant initializer or runtime. */
import {createHash} from 'node:crypto'
import {z} from 'zod'

const positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative()
const schema=z.object({fissionEnergy_MeV:positive,referenceFissionEnergy_MeV:positive,
 fissionProductAlpha_MeV_event_s:z.array(positive).length(23),
 fissionProductLambda_s_inv:z.array(positive).length(23),
 effectiveCaptureEnergy_MeV:z.array(nonnegative).length(2),
 effectiveCaptureTimeConstants_s:z.array(positive).length(2),
 referenceCaptureRatio:nonnegative,
 fissionProductSensitivity:z.array(positive).min(1),
 effectiveCaptureSensitivity:z.array(nonnegative).min(1)}).strict()
export type DecayHistoryRecord=z.infer<typeof schema>
const MeV_J=1.602176634e-13
export type EnergyGroup={feed:'fission'|'fertileCapture',energy_J_per_event:number,lambda_s_inv:number}
export type DecayHistoryKernel={fissionEnergy_J:number,promptFissionEnergy_J:number,groups:readonly EnergyGroup[]}
export type SourceRates={fission_s_inv:number,fertileCapture_s_inv:number}
export function parseDecayHistory(document:string){
 const blocks=[...document.matchAll(/^```reference-decay-history\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected exactly one reference-decay-history block')
 const record=schema.parse(JSON.parse(blocks[0]![1]!))
 compileDecayHistory(record)
 return record
}
function validateKernel(kernel:DecayHistoryKernel){
 const {groups,fissionEnergy_J,promptFissionEnergy_J}=kernel
 if(groups.length===0||groups.some(g=>!['fission','fertileCapture'].includes(g.feed)||!Number.isFinite(g.energy_J_per_event)||g.energy_J_per_event<0||!Number.isFinite(g.lambda_s_inv)||g.lambda_s_inv<=0))throw Error('Invalid retained-energy groups')
 const delayed=groups.filter(g=>g.feed==='fission').reduce((sum,g)=>sum+g.energy_J_per_event,0)
 if(!Number.isFinite(fissionEnergy_J)||fissionEnergy_J<=0||!Number.isFinite(promptFissionEnergy_J)||promptFissionEnergy_J<=0||delayed>=fissionEnergy_J||Math.abs(fissionEnergy_J-promptFissionEnergy_J-delayed)>1e-13*fissionEnergy_J)throw Error('Invalid fission event budget')
 return kernel
}
export function compileDecayHistory(record:DecayHistoryRecord,fissionProductScale=1,captureScale=1):DecayHistoryKernel{
 if(!Number.isFinite(fissionProductScale)||fissionProductScale<=0||!Number.isFinite(captureScale)||captureScale<0)throw Error('Invalid constitutive sensitivity')
 const groups:EnergyGroup[]=[...record.fissionProductAlpha_MeV_event_s.map((alpha,i)=>({feed:'fission' as const,
  energy_J_per_event:fissionProductScale*alpha/record.fissionProductLambda_s_inv[i]!*MeV_J,lambda_s_inv:record.fissionProductLambda_s_inv[i]!})),
  ...record.effectiveCaptureEnergy_MeV.map((energy,i)=>({feed:'fertileCapture' as const,energy_J_per_event:captureScale*energy*MeV_J,lambda_s_inv:1/record.effectiveCaptureTimeConstants_s[i]!}))]
 const fissionEnergy_J=record.fissionEnergy_MeV*MeV_J,
  promptFissionEnergy_J=fissionEnergy_J-groups.filter(g=>g.feed==='fission').reduce((s,g)=>s+g.energy_J_per_event,0)
 return validateKernel({fissionEnergy_J,promptFissionEnergy_J,groups})
}
/** Stable integral of newly produced energy released in the same interval.
 * 1-(1-exp(-x))/x must not subtract two nearly equal doubles for slow stores. */
export function releaseFraction(x:number){
 if(!Number.isFinite(x)||x<0)throw Error('Invalid decay interval')
 if(x<1e-3)return x*(.5+x*(-1/6+x*(1/24+x*(-1/120+x/720))))
 return 1+Math.expm1(-x)/x
}
export function decayDeposition(kernel:DecayHistoryKernel,stores_J:readonly number[],source:SourceRates){
 const {groups,promptFissionEnergy_J}=validateKernel(kernel)
 if(stores_J.length!==groups.length||stores_J.some(E=>!Number.isFinite(E)||E<0)||![source.fission_s_inv,source.fertileCapture_s_inv].every(r=>Number.isFinite(r)&&r>=0))throw Error('Invalid retained history or event rates')
 const decay_W=groups.reduce((sum,g,i)=>sum+g.lambda_s_inv*stores_J[i]!,0),prompt_W=promptFissionEnergy_J*source.fission_s_inv
 if(!Number.isFinite(decay_W+prompt_W))throw Error('Unrepresentable deposition')
 return {prompt_W,decay_W,total_W:prompt_W+decay_W}
}
/** Exact constant achieved-source interval. No reset, wall-clock or infinity
 * equilibrium. A future coupled solver still owns its varying source trials. */
export function advanceDecayHistory(kernel:DecayHistoryKernel,stores_J:readonly number[],source:SourceRates,seconds:number){
 const deposition=decayDeposition(kernel,stores_J,source),{groups}=kernel
 if(!Number.isFinite(seconds)||seconds<0)throw Error('Invalid simulated duration')
 const stores=groups.map((g,i)=>{
  const x=g.lambda_s_inv*seconds
  if(!Number.isFinite(x))throw Error('Unrepresentable decay interval')
  const survival=Math.exp(-x),releasedOld=stores_J[i]!*(-Math.expm1(-x)),
   production=g.energy_J_per_event*(g.feed==='fission'?source.fission_s_inv:source.fertileCapture_s_inv),
   releasedNew=production*seconds*releaseFraction(x),
   retainedNew=seconds===0?0:production*(-Math.expm1(-x))/g.lambda_s_inv,
   E=stores_J[i]!*survival+retainedNew
  if(![E,releasedOld,releasedNew].every(Number.isFinite))throw Error('Unrepresentable retained energy')
  return {E,released:releasedOld+releasedNew}
 })
 const prompt_J=deposition.prompt_W*seconds,decay_J=stores.reduce((sum,s)=>sum+s.released,0),
  fissionSource_J=kernel.fissionEnergy_J*source.fission_s_inv*seconds,
  captureReserve_J=groups.filter(g=>g.feed==='fertileCapture').reduce((s,g)=>s+g.energy_J_per_event,0)*source.fertileCapture_s_inv*seconds,
  source_J=fissionSource_J+captureReserve_J,stores_J_new=stores.map(s=>s.E),
  retainedChange_J=stores_J_new.reduce((sum,E,i)=>sum+E-stores_J[i]!,0),
  balance_J=source_J-prompt_J-decay_J-retainedChange_J
 if(![prompt_J,decay_J,source_J,retainedChange_J,balance_J].every(Number.isFinite))throw Error('Unrepresentable energy ledger')
 return {stores_J:stores_J_new,prompt_J,decay_J,fissionSource_J,captureReserve_J,source_J,retainedChange_J,balance_J,
  final:decayDeposition(kernel,stores_J_new,source)}
}

export function decayHistoryVerification(record:DecayHistoryRecord){
 const kernel=compileDecayHistory(record),{groups}=kernel,empty=groups.map(()=>0),day=86400,
  referenceFission_s_inv=3e9/(record.referenceFissionEnergy_MeV*MeV_J),
  prescribed={fission_s_inv:referenceFission_s_inv,fertileCapture_s_inv:record.referenceCaptureRatio*referenceFission_s_inv},
  off={fission_s_inv:0,fertileCapture_s_inv:0},
  checks:{name:string,value?:number}[]=[],
  require=(name:string,ok:boolean,value?:number)=>{if(!ok)throw Error(name);checks.push({name,...(value===undefined?{}:{value})})},
  close=(a:number,b:number,tolerance=3e-13)=>Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b)),
  sum=(values:readonly number[])=>values.reduce((s,v)=>s+v,0),
  times=[3600,day,3*day,7*day,30*day,365*day],histories=[]
 require('25 positive stores with distinct 23 fission and 2 capture feeds',groups.length===25&&groups.every(g=>g.energy_J_per_event>0)&&groups.filter(g=>g.feed==='fission').length===23&&groups.filter(g=>g.feed==='fertileCapture').length===2)
 for(const days of [1,30,600]){
  const irradiation=advanceDecayHistory(kernel,empty,prescribed,days*day)
  require('finite irradiation energy budget '+days,Math.abs(irradiation.balance_J)<=3e-13*irradiation.source_J,irradiation.balance_J)
  const shutdown=times.map(seconds=>{
   const r=advanceDecayHistory(kernel,irradiation.stores_J,off,seconds)
   require('shutdown positive stores and energy budget '+days+'/'+seconds,r.stores_J.every(E=>E>=0)&&Math.abs(r.balance_J)<=3e-13*sum(irradiation.stores_J),r.balance_J)
   return {seconds,decay_W:r.final.decay_W,released_J:r.decay_J,retained_J:sum(r.stores_J),stores_J:r.stores_J}
  })
  require('shutdown decays without forgetting history '+days,shutdown.every((r,i)=>i===0||r.decay_W<shutdown[i-1]!.decay_W))
  histories.push({days,source:prescribed,irradiation,shutdown})
 }
 const pulses=['fission','fertileCapture'].map(feed=>{
  const stores=groups.map(g=>g.feed===feed?g.energy_J_per_event:0),pulse=advanceDecayHistory(kernel,stores,off,1e16),
   prompt_J=feed==='fission'?kernel.promptFissionEnergy_J:0,
   eventual_J=feed==='fission'?kernel.fissionEnergy_J:sum(stores)
  require('one '+feed+' pulse retains exactly its separate event energy',Math.abs((pulse.decay_J+sum(pulse.stores_J)+prompt_J)/eventual_J-1)<1e-14)
  return {feed,eventual_J,eventPrompt_J:prompt_J,...pulse}
 })
 const sourceA={fission_s_inv:referenceFission_s_inv/3,fertileCapture_s_inv:0},
  sourceC={fission_s_inv:referenceFission_s_inv*2/3,fertileCapture_s_inv:referenceFission_s_inv/5},
  a=advanceDecayHistory(kernel,empty,sourceA,17),b=advanceDecayHistory(kernel,a.stores_J,off,21),
  c=advanceDecayHistory(kernel,b.stores_J,sourceC,35),
  pause=advanceDecayHistory(kernel,c.stores_J,sourceC,0),copy=advanceDecayHistory(kernel,[...c.stores_J],off,89),
  parcels=[.2,.3,.5].map(f=>advanceDecayHistory(kernel,c.stores_J.map(E=>E*f),off,89)),
  one=advanceDecayHistory(kernel,c.stores_J,sourceC,89),left=advanceDecayHistory(kernel,c.stores_J,sourceC,19),
  right=advanceDecayHistory(kernel,left.stores_J,sourceC,70)
 require('same present fission does not imply same retained heat',histories[2]!.irradiation.final.total_W>histories[0]!.irradiation.final.total_W)
 require('pause preserves all extensive stores exactly',pause.stores_J.every((E,i)=>E===c.stores_J[i])&&pause.source_J===0&&pause.decay_J===0)
 require('copy does not mutate original stores',copy.stores_J.every((E,i)=>E<c.stores_J[i]!)&&c.stores_J.every(E=>E>0))
 require('parcel-summed inventories and heat equal one original, not three clones',copy.stores_J.every((E,i)=>close(E,sum(parcels.map(p=>p.stores_J[i]!))))&&close(copy.final.decay_W,sum(parcels.map(p=>p.final.decay_W))))
 require('split source intervals retain identical state and ledger',one.stores_J.every((E,i)=>close(E,right.stores_J[i]!))&&close(one.decay_J,left.decay_J+right.decay_J)&&close(one.prompt_J,left.prompt_J+right.prompt_J))
 require('restart retains interrupted heat, not a fresh reset',c.final.total_W>advanceDecayHistory(kernel,empty,sourceC,35).final.total_W)
 const captureOnly=advanceDecayHistory(kernel,empty,{fission_s_inv:0,fertileCapture_s_inv:referenceFission_s_inv},10),
  fissionOnly=advanceDecayHistory(kernel,empty,{fission_s_inv:referenceFission_s_inv,fertileCapture_s_inv:0},10)
 require('capture without fission populates only capture stores and supplies no fission prompt',captureOnly.prompt_J===0&&captureOnly.stores_J.every((E,i)=>groups[i]!.feed==='fertileCapture'?E>0:E===0))
 require('fission without capture does not invent fertile history',fissionOnly.stores_J.every((E,i)=>groups[i]!.feed==='fission'?E>0:E===0))
 const sensitivities=record.fissionProductSensitivity.flatMap(fp=>record.effectiveCaptureSensitivity.map(capture=>{
  const stressed=compileDecayHistory(record,fp,capture),irradiation=advanceDecayHistory(stressed,empty,prescribed,600*day),
   shutdown=times.map(seconds=>({seconds,decay_W:advanceDecayHistory(stressed,irradiation.stores_J,off,seconds).final.decay_W}))
  require('stress conserves fission budget and separately declared capture reserve '+fp+'/'+capture,stressed.promptFissionEnergy_J>0&&Math.abs(irradiation.balance_J)<=3e-13*irradiation.source_J)
  return {fissionProductScale:fp,captureScale:capture,promptFissionEnergy_MeV:stressed.promptFissionEnergy_J/MeV_J,shutdown}
 }))
 return {scope:'Separate fission-product and fertile-capture retained-energy kernel only; no prompt capture binding, Mn product, spatial photon deposition, achieved irradiation/cooldown, isotope/dose or operating permission',checks,
  kernel,referenceFission_s_inv,prescribedCaptureHistoryIsNotOperationalRatio:true,histories,
  interrupted:{segments:[{source:sourceA,seconds:17},{source:off,seconds:21},{source:sourceC,seconds:35}],stores_J:c.stores_J,final:c.final},
  sensitivities,pulses}
}
if(import.meta.main){
 const [owner,output,...rest]=Bun.argv.slice(2)
 if(!owner||!output||rest.length)throw Error('Usage: decay-history <heat-and-history.md> <receipt.json>')
 const document=await Bun.file(owner).text(),record=parseDecayHistory(document),source=await Bun.file(import.meta.path).text(),
  start=performance.now(),result=decayHistoryVerification(record),calculation_ms=performance.now()-start,
  sha=(text:string)=>createHash('sha256').update(text).digest('hex'),
  receipt={sourceSHA256:sha(source),consumedInputSHA256:sha(JSON.stringify(record)),ownerContextSHA256:sha(document),
   consumedInput:record,dependencies:{bun:Bun.version},calculation_ms,...result}
 if(source!==await Bun.file(import.meta.path).text())throw Error('Decay source changed during calculation')
 await Bun.write(output,JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({output,checks:result.checks.length,calculation_ms,shutdown600d:result.histories[2]?.shutdown.map(({seconds,decay_W})=>({seconds,decay_W}))}))
}
