/** Offline retained-energy verification; not a plant initializer or runtime. */
import {createHash} from 'node:crypto'
import {z} from 'zod'

const positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative()
const schema=z.object({eventEnergy_MeV:positive,
 fissionProductAlpha_MeV_event_s:z.array(positive).length(23),
 fissionProductLambda_s_inv:z.array(positive).length(23),
 effectiveCaptureFractions:z.array(nonnegative).length(2),
 effectiveCaptureTimeConstants_s:z.array(positive).length(2),
 fissionProductSensitivity:z.array(positive).min(1),
 effectiveCaptureSensitivity:z.array(nonnegative).min(1)}).strict()
export type DecayHistoryRecord=z.infer<typeof schema>
export type EnergyGroup={fraction:number,lambda_s_inv:number}
export function parseDecayHistory(document:string){
 const blocks=[...document.matchAll(/^```reference-decay-history\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected exactly one reference-decay-history block')
 const record=schema.parse(JSON.parse(blocks[0]![1]!))
 decayHistoryGroups(record)
 return record
}
function validateGroups(groups:readonly EnergyGroup[]){
 if(groups.length===0||groups.some(g=>!Number.isFinite(g.fraction)||g.fraction<0||!Number.isFinite(g.lambda_s_inv)||g.lambda_s_inv<=0))throw Error('Invalid retained-energy groups')
 const fraction=groups.reduce((sum,g)=>sum+g.fraction,0)
 if(!Number.isFinite(fraction)||fraction>=1)throw Error('Delayed energy exceeds the single event budget')
 return fraction
}
export function decayHistoryGroups(record:DecayHistoryRecord,fissionProductScale=1,captureScale=1):EnergyGroup[]{
 if(!Number.isFinite(fissionProductScale)||fissionProductScale<=0||!Number.isFinite(captureScale)||captureScale<0)throw Error('Invalid constitutive sensitivity')
 const groups=[...record.fissionProductAlpha_MeV_event_s.map((alpha,i)=>({
  fraction:fissionProductScale*alpha/(record.fissionProductLambda_s_inv[i]!*record.eventEnergy_MeV),lambda_s_inv:record.fissionProductLambda_s_inv[i]!})),
  ...record.effectiveCaptureFractions.map((fraction,i)=>({fraction:captureScale*fraction,lambda_s_inv:1/record.effectiveCaptureTimeConstants_s[i]!}))]
 validateGroups(groups)
 return groups
}
/** Stable integral of newly produced energy released in the same interval.
 * 1-(1-exp(-x))/x must not subtract two nearly equal doubles for slow stores. */
export function releaseFraction(x:number){
 if(!Number.isFinite(x)||x<0)throw Error('Invalid decay interval')
 if(x<1e-3)return x*(.5+x*(-1/6+x*(1/24+x*(-1/120+x/720))))
 return 1+Math.expm1(-x)/x
}
export function decayDeposition(groups:readonly EnergyGroup[],stores_J:readonly number[],fission_W:number){
 const delayed=validateGroups(groups)
 if(stores_J.length!==groups.length||stores_J.some(E=>!Number.isFinite(E)||E<0)||!Number.isFinite(fission_W)||fission_W<0)throw Error('Invalid retained history or achieved fission')
 const decay_W=groups.reduce((sum,g,i)=>sum+g.lambda_s_inv*stores_J[i]!,0),prompt_W=(1-delayed)*fission_W
 if(!Number.isFinite(decay_W+prompt_W))throw Error('Unrepresentable deposition')
 return {prompt_W,decay_W,total_W:prompt_W+decay_W}
}
/** Exact constant achieved-source interval. No reset, wall-clock or infinity
 * equilibrium. A future coupled solver still owns its varying source trials. */
export function advanceDecayHistory(groups:readonly EnergyGroup[],stores_J:readonly number[],fission_W:number,seconds:number){
 const deposition=decayDeposition(groups,stores_J,fission_W)
 if(!Number.isFinite(seconds)||seconds<0)throw Error('Invalid simulated duration')
 const stores=groups.map((g,i)=>{
  const x=g.lambda_s_inv*seconds
  if(!Number.isFinite(x))throw Error('Unrepresentable decay interval')
  const survival=Math.exp(-x),releasedOld=stores_J[i]!*(-Math.expm1(-x)),
   production=g.fraction*fission_W,
   releasedNew=production*seconds*releaseFraction(x),
   retainedNew=seconds===0?0:production*(-Math.expm1(-x))/g.lambda_s_inv,
   E=stores_J[i]!*survival+retainedNew
  if(![E,releasedOld,releasedNew].every(Number.isFinite))throw Error('Unrepresentable retained energy')
  return {E,released:releasedOld+releasedNew}
 })
 const prompt_J=deposition.prompt_W*seconds,decay_J=stores.reduce((sum,s)=>sum+s.released,0),
  source_J=fission_W*seconds,stores_J_new=stores.map(s=>s.E),
  retainedChange_J=stores_J_new.reduce((sum,E,i)=>sum+E-stores_J[i]!,0),
  balance_J=source_J-prompt_J-decay_J-retainedChange_J
 if(![prompt_J,decay_J,source_J,retainedChange_J,balance_J].every(Number.isFinite))throw Error('Unrepresentable energy ledger')
 return {stores_J:stores_J_new,prompt_J,decay_J,source_J,retainedChange_J,balance_J,
  final:decayDeposition(groups,stores_J_new,fission_W)}
}

export function decayHistoryVerification(record:DecayHistoryRecord){
 const groups=decayHistoryGroups(record),empty=groups.map(()=>0),day=86400,power=3e9,
  checks:{name:string,value?:number}[]=[],
  require=(name:string,ok:boolean,value?:number)=>{if(!ok)throw Error(name);checks.push({name,...(value===undefined?{}:{value})})},
  close=(a:number,b:number,tolerance=3e-13)=>Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b)),
  sum=(values:readonly number[])=>values.reduce((s,v)=>s+v,0),
  times=[3600,day,3*day,7*day,30*day,365*day],histories=[]
 require('selected positive 25 stores and event normalization',groups.length===25&&groups.every(g=>g.fraction>0)&&close(sum(groups.map(g=>g.fraction)),.07207918033039279))
 for(const days of [1,30,600]){
  const irradiation=advanceDecayHistory(groups,empty,power,days*day)
  require('finite irradiation energy budget '+days,Math.abs(irradiation.balance_J)<=3e-13*irradiation.source_J,irradiation.balance_J)
  const shutdown=times.map(seconds=>{
   const r=advanceDecayHistory(groups,irradiation.stores_J,0,seconds)
   require('shutdown positive stores and energy budget '+days+'/'+seconds,r.stores_J.every(E=>E>=0)&&Math.abs(r.balance_J)<=3e-13*sum(irradiation.stores_J),r.balance_J)
   return {seconds,decay_W:r.final.decay_W,released_J:r.decay_J,retained_J:sum(r.stores_J),stores_J:r.stores_J}
  })
  require('shutdown decays without forgetting history '+days,shutdown.every((r,i)=>i===0||r.decay_W<shutdown[i-1]!.decay_W))
  histories.push({days,eventualPower_W:power,irradiation,shutdown})
 }
 const pulse_J=record.eventEnergy_MeV*1.602176634e-13,
  pulseStores=groups.map(g=>g.fraction*pulse_J),pulse=advanceDecayHistory(groups,pulseStores,0,1e16),
  promptPulse=(1-sum(groups.map(g=>g.fraction)))*pulse_J
 require('one pulse releases exactly its allocated event energy',Math.abs((pulse.decay_J+sum(pulse.stores_J)+promptPulse)/pulse_J-1)<1e-14)
 const a=advanceDecayHistory(groups,empty,1e9,17),b=advanceDecayHistory(groups,a.stores_J,0,21),
  c=advanceDecayHistory(groups,b.stores_J,2e9,35),
  pause=advanceDecayHistory(groups,c.stores_J,2e9,0),copy=advanceDecayHistory(groups,[...c.stores_J],0,89),
  parcels=[.2,.3,.5].map(f=>advanceDecayHistory(groups,c.stores_J.map(E=>E*f),0,89)),
  one=advanceDecayHistory(groups,c.stores_J,2e9,89),left=advanceDecayHistory(groups,c.stores_J,2e9,19),
  right=advanceDecayHistory(groups,left.stores_J,2e9,70)
 require('same present fission does not imply same retained heat',histories[2]!.irradiation.final.total_W>histories[0]!.irradiation.final.total_W)
 require('pause preserves all extensive stores exactly',pause.stores_J.every((E,i)=>E===c.stores_J[i])&&pause.source_J===0&&pause.decay_J===0)
 require('copy does not mutate original stores',copy.stores_J.every((E,i)=>E<c.stores_J[i]!)&&c.stores_J.every(E=>E>0))
 require('parcel-summed inventories and heat equal one original, not three clones',copy.stores_J.every((E,i)=>close(E,sum(parcels.map(p=>p.stores_J[i]!))))&&close(copy.final.decay_W,sum(parcels.map(p=>p.final.decay_W))))
 require('split source intervals retain identical state and ledger',one.stores_J.every((E,i)=>close(E,right.stores_J[i]!))&&close(one.decay_J,left.decay_J+right.decay_J)&&close(one.prompt_J,left.prompt_J+right.prompt_J))
 require('restart retains interrupted heat, not a fresh reset',c.final.total_W>advanceDecayHistory(groups,empty,2e9,35).final.total_W)
 const sensitivities=record.fissionProductSensitivity.flatMap(fp=>record.effectiveCaptureSensitivity.map(capture=>{
  const stressed=decayHistoryGroups(record,fp,capture),irradiation=advanceDecayHistory(stressed,empty,power,600*day),
   shutdown=times.map(seconds=>({seconds,decay_W:advanceDecayHistory(stressed,irradiation.stores_J,0,seconds).final.decay_W}))
  require('stress prompt allocation stays within single event budget '+fp+'/'+capture,validateGroups(stressed)<1&&Math.abs(irradiation.balance_J)<=3e-13*irradiation.source_J)
  return {fissionProductScale:fp,captureScale:capture,promptFraction:1-validateGroups(stressed),shutdown}
 }))
 return {scope:'Selected finite retained-energy kernel and event ledger only; no achieved plant cooldown, spatial neutron model, receiver endurance, isotope/dose or operating permission',checks,
  groups,eventEnergy_J:pulse_J,promptFraction:1-validateGroups(groups),histories,
  interrupted:{segments:[{power_W:1e9,seconds:17},{power_W:0,seconds:21},{power_W:2e9,seconds:35}],stores_J:c.stores_J,final:c.final},
  sensitivities,pulse:{eventPrompt_J:promptPulse,...pulse}}
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
