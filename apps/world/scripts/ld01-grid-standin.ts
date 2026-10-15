/** TEST-ONLY Grid stand-in for C5 (C5X lane, owner decisions D1 + D2). It is
 * NOT the World Grid Pack, is never registered in a Pack, the Runtime Hub or
 * the deployer (scripts/ is not shipped; owner F4: live registration is not
 * approved), and has no production use or fallback role. It plays phase 1 of
 * the ordered electrical join against one `ld01-c5-host` child, as ELEC's
 * ADR draft's contract states it:
 * - **D1** (adaptive exchange, `ld01-electrical-exchange` on the handoff
 *   page): 1 s intervals in quiet operation, 20 ms only inside grid-event
 *   windows that the Grid side declares in the exchange; known
 *   discontinuities split an interval exactly.
 * - **D2** (carrier as a continuous input, `ld01-generator-carrier`): with
 *   each boundary the Grid hands its frequency at t0 and the accepted carrier
 *   phase error `e(t0)`: the integral of its own frequency deviation from the
 *   value it held over the previous interval (zero, exactly, while the
 *   frequency is unchanged).
 * - Receipts: the plant's IDAS export/auxiliary quadratures per interval.
 *
 * The Grid's own island is a stand-in input, not a Grid model: a stiff bus at
 * the packet's 50 Hz, optionally with one frequency event following the
 * operating Grid's (removed) frequency law of the wiki's executed
 * counterexample (operating-scale-realization.md, 5 Oct: effective time
 * constant 10 s; a steady deviation of 0.36 Hz reproduces its printed
 * 49.97801965 Hz one second after an event at 0.37 s, and the 20 ms
 * endpoint error 0.00033819 Hz; both are checked below). C5's LOOP is
 * S3-D10's dead bus at the case's declared 10.37 s with its declared 30 s
 * window.
 *
 * Usage: bun scripts/ld01-grid-standin.ts <ld01-c5-host> <plan.json> <receipt.json>
 * with the C5 environment (S3 packet, state, sections, ELEC packet) and
 * LD01_EXCHANGE_WIKI (the wiki root holding the D1 block). */
import {existsSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {spawnFramed,type Reply} from './ld01-host-spike'
import {exchangeOwner,parseExchange} from './reference-design-operating-electrical'

const Op={load:1,exchange:12,report:13,status:10,close:9} as const
const text=new TextEncoder(),utf8=new TextDecoder()

export type Receipt={t0:number,t1:number,window:boolean,exportJ:number,unitDrawJ:number,reserveDrawJ:number,
 cumulativeExportJ:number,exportW:number,speedRadS:number,thetaRad:number,ieqA:number,carrierRadS:number,
 joined:boolean,offsiteLost:boolean,rcpSupported:number,ruleICpuS:number,arcHeatJ:number,
 steps:number,jacobians:number,residuals:number,rInterval:number,sInterval:number,rTotal:number,sTotal:number,
 oTotal:number,ruleIExit:boolean,signals:number[],events:Record<string,unknown>|null,
 roundTripS:number,handlerWallS:number,handlerCpuS:number}

/** One child hosting the S3 unit with ELEC's slice on the frame driver. */
export function spawnC5(binary:string){
 const host=spawnFramed(binary)
 return {
  pid:host.pid,exited:host.exited,
  load:async(config:Record<string,unknown>)=>JSON.parse(utf8.decode((await host.request(Op.load,text.encode(JSON.stringify(config)))).data)) as Record<string,unknown>,
  exchange:async(t1:number,window:boolean,observe:boolean,energized:boolean,voltagePu:number,frequencyHz:number,phaseErrorRad:number):Promise<Receipt>=>{
   const p=new Uint8Array(35),v=new DataView(p.buffer)
   v.setFloat64(0,t1,true);p[8]=window?1:0;p[9]=observe?1:0;p[10]=energized?1:0
   v.setFloat64(11,voltagePu,true);v.setFloat64(19,frequencyHz,true);v.setFloat64(27,phaseErrorRad,true)
   const r:Reply=await host.request(Op.exchange,p),d=new DataView(r.data.buffer,r.data.byteOffset,r.data.byteLength)
   const f=(k:number)=>d.getFloat64(8*k,true),i=(k:number)=>Number(d.getBigInt64(128+8*k,true))
   const n=d.getUint32(208,true),signals=Array.from({length:n},(_,k)=>d.getFloat64(212+8*k,true))
   const at=212+8*n,m=d.getUint32(at,true)
   return {t0:f(0),t1:f(1),window,exportJ:f(2),unitDrawJ:f(3),reserveDrawJ:f(4),cumulativeExportJ:f(5),exportW:f(6),
    speedRadS:f(7),thetaRad:f(8),ieqA:f(9),carrierRadS:f(10),joined:f(11)===1,offsiteLost:f(12)===1,rcpSupported:f(13),
    ruleICpuS:f(14),arcHeatJ:f(15),steps:i(0),jacobians:i(1),residuals:i(2),rInterval:i(3),sInterval:i(4),rTotal:i(5),
    sTotal:i(6),oTotal:i(7),ruleIExit:i(8)===1,signals,events:m?JSON.parse(utf8.decode(r.data.slice(at+4,at+4+m))):null,
    roundTripS:r.roundTripS,handlerWallS:r.handlerWallS,handlerCpuS:r.handlerCpuS}
  },
  report:async(zero:number)=>{
   const p=new Uint8Array(8);new DataView(p.buffer).setFloat64(0,zero,true)
   return JSON.parse(utf8.decode((await host.request(Op.report,p)).data)) as Record<string,any>
  },
  status:async()=>JSON.parse(utf8.decode((await host.request(Op.status)).data)) as Record<string,unknown>,
  close:async()=>{await host.request(Op.close);return host.exited},
 }
}

/** The stand-in's island frequency: 50 Hz, and after an event at `te` the
 * counterexample's first-order law toward `-deviation` with time constant `tau`. */
export type FrequencyEvent={te:number,deviationHz:number,tauS:number}
export function island(nominalHz:number,event:FrequencyEvent|null){
 const f=(t:number)=>!event||t<=event.te?nominalHz:nominalHz-event.deviationHz*(1-Math.exp(-(t-event.te)/event.tauS))
 // G(t) = integral from te to t of (f - nominal): exactly 0 before the event.
 const g=(t:number)=>!event||t<=event.te?0:-event.deviationHz*((t-event.te)-event.tauS*(1-Math.exp(-(t-event.te)/event.tauS)))
 /** D2: the accepted carrier phase at t0 less the phase followed from tPrev at the held f(tPrev). */
 const phaseError=(tPrev:number,t0:number)=>{
  const dev=g(t0)-g(tPrev)-(f(tPrev)-nominalHz)*(t0-tPrev)
  return dev===0?0:2*Math.PI*dev
 }
 return {f,phaseError}
}

/** The counterexample's own numbers, checked before any use of its law. */
function checkCounterexample(){
 const law=island(50,{te:.37,deviationHz:.36,tauS:10}).f
 const at1=law(1),late=island(50,{te:.38,deviationHz:.36,tauS:10}).f(1)
 const ok=Math.abs(at1-49.97801965)<5e-9&&Math.abs((late-at1)-0.00033819)<5e-9
 if(!ok)throw Error(`the counterexample law does not reproduce its printed values: ${at1}, ${late-at1}`)
 return {f_at_1s:at1,endpoint_error_20ms_hz:late-at1}
}

export type Plan={name:string,kind:'C5'|'D2',windowIntervalS:number,quietIntervalS:number,windowS:number,
 durationS:number,eventAtS:number,frequencyEvent:{deviationHz:number,tauS:number}|null,toleranceFactor:number,maxStepS:number|null,
 /** The plant's own E2 event window after the LOOP (C5 declaration: 20 ms cap over 30 s), or null. */
 plantWindow:{capS:number,durationS:number}|null,
 /** The Grid's window applies to connected units only (ADR draft G4; design note §6.2 A). */
 gridWindowConnectedOnly:boolean,
 observeEveryS:number}

/** The common boundaries: quiet intervals on the whole-second grid from the start, split exactly at the event, the
 * declared window at the window interval, then quiet again. */
function boundaries(t0:number,p:Plan){
 const te=t0+p.eventAtS,we=te+p.windowS,end=t0+p.durationS,out:{t1:number,window:boolean}[]=[]
 let t=t0
 const push=(t1:number,window:boolean)=>{out.push({t1,window});t=t1}
 while(t<te-1e-9)push(Math.min(t0+Math.round((t-t0)/p.quietIntervalS+1)*p.quietIntervalS,te),false)
 let k=1
 // A dead bus disconnects the unit: with connected-only windows it keeps the quiet cadence (C5 after the LOOP).
 const windowInterval=p.kind==='C5'&&p.gridWindowConnectedOnly?p.quietIntervalS:p.windowIntervalS
 while(t<Math.min(we,end)-1e-9){push(Math.min(te+k*windowInterval,we,end),true);k++}
 while(t<end-1e-9)push(Math.min(t0+Math.floor((t-t0)/p.quietIntervalS+1e-9+1)*p.quietIntervalS,end),false)
 return {te,we,end,out}
}

async function run(binary:string,state:string,p:Plan){
 const plant=spawnC5(binary)
 const load=await plant.load({state,tolerance_factor:p.toleranceFactor,max_step_s:p.maxStepS,
  event_window:p.plantWindow&&{cap_s:p.plantWindow.capS,duration_s:p.plantWindow.durationS}})
 const t0=load.t as number,{te,we,end,out}=boundaries(t0,p)
 const grid=island(50,p.frequencyEvent&&{te,...p.frequencyEvent})
 const receipts:Receipt[]=[]
 let refusal:string|null=null,tPrev=t0
 for(const {t1,window} of out){
  const tStart=receipts.at(-1)?.t1??t0
  const energized=p.kind==='D2'||tStart<te-1e-9
  const observe=Math.abs((t1-t0)/p.observeEveryS-Math.round((t1-t0)/p.observeEveryS))<1e-6
  const e=receipts.length?grid.phaseError(tPrev,tStart):0
  try{receipts.push(await plant.exchange(t1,window,observe,energized,energized?1:0,energized?grid.f(tStart):0,energized?e:0))}
  catch(x){refusal=(x as Error).message;break}
  tPrev=tStart
 }
 const report=await plant.report(te).catch(x=>({refusal:(x as Error).message}))
 const status=await plant.status()
 await plant.close()
 return {load,t0,te,we,end,receipts,refusal,report,status}
}

function quantiles(values:number[]){
 const s=[...values].sort((a,b)=>a-b),q=(x:number)=>s[Math.min(s.length-1,Math.floor(x*s.length))]??NaN
 return {n:s.length,p50:q(.5),p95:q(.95),max:s.at(-1)??NaN}
}

/** Cost, receipts, held-power error and (C5) the declared lines on the run's own logs, as a preview. */
function analyse(p:Plan,r:Awaited<ReturnType<typeof run>>){
 const x=r.receipts
 if(!x.length)return {plan:p,refusal:r.refusal,report:r.report}
 let sum=0;for(const q of x)sum+=q.exportJ
 const cumulative=x.at(-1)!.cumulativeExportJ-(x[0]!.cumulativeExportJ-x[0]!.exportJ)
 // Today's Grid holds the last committed MW over the next interval.
 const held=x.map((q,k)=>k?Math.abs((x[k-1]!.exportW)*(q.t1-q.t0)-q.exportJ):0)
 const at=(t:number)=>x.findIndex(q=>Math.abs(q.t0-t)<1e-9)
 const loopK=at(r.te)
 // Plant CPU per exchange: the handler less rule I (harness) and host observation.
 const plantCpu=(q:Receipt)=>q.handlerCpuS-q.ruleICpuS-Number((q.events as any)?.observe_cpu_s??0)
 const span=(sel:(q:Receipt)=>boolean)=>{
  const s=x.filter(sel),sim=s.reduce((a,q)=>a+q.t1-q.t0,0),cpu=s.reduce((a,q)=>a+plantCpu(q),0)
  return {simulated_s:sim,plant_cpu_s:cpu,cpu_s_per_s:sim?cpu/sim:null,exchanges:s.length,
   r:s.reduce((a,q)=>a+q.rInterval,0),s:s.reduce((a,q)=>a+q.sInterval,0)}
 }
 const pre=span(q=>q.t1<=r.te+1e-9),window=span(q=>q.window),whole=span(()=>true)
 // Quiet operation past the restart-from-saved-state transient (the first 3 s after LOAD).
 const quietSteady=span(q=>!q.window&&q.t0>=r.t0+3-1e-9&&q.t1<=r.te+1e-9)
 const post=span(q=>!q.window&&q.t0>=r.te-1e-9)
 const overhead=x.map(q=>q.roundTripS-q.handlerWallS)
 const rep=r.report as Record<string,any>
 const tl=rep.timeline??{}
 const elec:[number,string][]=tl.electrical??[]
 const first=(s:string)=>elec.find(([,w])=>w.includes(s))?.[0]??null
 const reqs:[number,{request:string,t_s:number}][]=tl.requests??[]
 const lines=p.kind!=='C5'?null:{
  note:'PREVIEW (NOT evidence): the C5 lines of the S3 r3 research draft judged on the run\'s own logs, times from the LOOP',
  'must t0: export step, supplies lost, feed gated':{export_before_W:loopK>0?x[loopK-1]!.exportW:null,
   receipt_after_J:loopK>=0?x[loopK]!.exportJ:null,offsite_lost:first('offsite connection lost'),
   rcp_supported_after:loopK>=0?x[loopK]!.rcpSupported:null},
  'must t0+1.00: motor contactors drop out':{first:first('contactor undervoltage dropout'),
   all:elec.filter(([,w])=>w.includes('dropout')).map(([t])=>t)},
  'must: acquired trip cause, release, seating, PRHR':{trips:tl.trips,holding_lost:tl.holding_lost,seats:(tl.seats??[]).length,
   last_seat:(tl.seats??[]).reduce((a:number,[,t]:[string,number])=>Math.max(a,t),-Infinity),
   prhr:reqs.filter(([,q])=>q.request==='PRHR').map(([d,q])=>[d,q.t_s-r.te])},
  'must t0+0.2 (+0.3 travel): GCB opens, turbine trip':{gcb_open_requested:first('GCB OPEN requested'),gcb_open:first('GCB Open'),stop_ramp_end:tl.stop_ramp_end},
  'must first 20 s: SG relief opening':{sg_relief:(tl.sg_relief??[]).filter((v:any[])=>v[3]<=20)},
  'must not: CMT request; PZR low level <= 3.00 m':{cmt:reqs.filter(([,q])=>q.request==='CMT injection'),
   monitors:(rep.divisions??[]).map((d:any)=>d.monitors)},
  'may: PZR high pressure; PZR relief':{pzr_relief_openings:tl.pzr_relief_openings,
   causes:(tl.causes??[]).filter((c:any[])=>String(c[1]).includes('HIGH_PRESSURE'))},
 }
 return {
  plan:p,refusal:r.refusal,t0:r.t0,event_s:r.te,window_end_s:r.we,end_s:r.end,reached_s:x.at(-1)!.t1,
  load:{cpu_s:r.load.cpu_s,max_rss_bytes:r.load.max_rss_bytes,rtol:r.load.rtol,max_step_s:r.load.max_step_s,carrier_law:r.load.carrier_law,
   boundary:r.load.boundary,composition_start:(r.load.composition as any)?.start},
  receipts_closure:{sum_J:sum,cumulative_J:cumulative,bitwise:sum===cumulative,difference_J:sum-cumulative,
   unit_draw_J:x.reduce((a,q)=>a+q.unitDrawJ,0),reserve_draw_J:x.reduce((a,q)=>a+q.reserveDrawJ,0)},
  held_power_error:{event_interval_J:loopK>=0?held[loopK]:null,event_interval_s:loopK>=0?x[loopK]!.t1-x[loopK]!.t0:null,
   whole_run_J:held.reduce((a,b)=>a+b,0)},
  cost:{pre_event:pre,quiet_steady:quietSteady,window,post_window:post,whole,budget_cpu_s_per_s:.5,
   rule_i_cpu_s:x.reduce((a,q)=>a+q.ruleICpuS,0),overhead_s:quantiles(overhead),handler_cpu_s:quantiles(x.map(plantCpu))},
  counts_by_class:rep.counts_by_class,stock_totals:rep.stock_totals,driver_cpu:rep.cpu,rule_i:rep.rule_i,
  pzr_control:rep.pzr_control,lines,timeline:tl,divisions:rep.divisions,
  series:x.filter(q=>q.signals.length||Math.abs(q.t1-Math.round(q.t1))<1e-9).map(q=>({t:q.t1-r.te,P:q.exportW,E:q.cumulativeExportJ,
   omega:q.speedRadS,theta:q.thetaRad,ieq:q.ieqA,carrier:q.carrierRadS,rcp:q.rcpSupported,s:q.signals})),
  boundaries:x.map(q=>[q.t0,q.t1,q.window?1:0,q.exportJ,q.exportW,q.ieqA,q.rInterval,q.sInterval,plantCpu(q)]),
  events:x.filter(q=>q.events).map(q=>({t0:q.t0,...q.events})),
  routing_records:(rep.routing_records??[]).map(([t,w]:[number,string])=>[t-r.te,w]),
  instants:rep.instants,refusal_report:rep.refusal??null,
 }
}

if(import.meta.main){
 const [binary,planPath,target,...extra]=Bun.argv.slice(2)
 if(!binary||!planPath||!target||extra.length)throw Error('Usage: bun scripts/ld01-grid-standin.ts <ld01-c5-host> <plan.json> <receipt.json>')
 if(existsSync(target))throw Error(`${target} exists: receipts are never overwritten`)
 const wiki=process.env.LD01_EXCHANGE_WIKI,state=process.env.LD01_S3_STATE
 if(!wiki||!state)throw Error('LD01_EXCHANGE_WIKI and LD01_S3_STATE are required')
 const law=parseExchange(await Bun.file(join(wiki,'world/packs/process-plant/reference-designs/ld-01',exchangeOwner.page)).text())
 const counterexample=checkCounterexample()
 const spec=await Bun.file(planPath).json() as {runs:(Omit<Plan,'quietIntervalS'|'windowIntervalS'>&{window:'window'|'refinement'|'quiet'|number})[]}
 const results=[]
 for(const s of spec.runs){
  const windowIntervalS=s.window==='window'?law.windowInterval_s:s.window==='refinement'?law.refinementInterval_s:
   s.window==='quiet'?law.quietInterval_s:s.window
  const plan:Plan={...s,quietIntervalS:law.quietInterval_s,windowIntervalS} as Plan
  const w0=performance.now()
  const result=analyse(plan,await run(binary,state,plan))
  results.push({...result,wall_s:(performance.now()-w0)/1e3})
  console.log(JSON.stringify({run:plan.name,reached:(result as any).reached_s,refusal:result.refusal,
   cost:(result as any).cost&&{pre:(result as any).cost.pre_event.cpu_s_per_s,window:(result as any).cost.window.cpu_s_per_s,whole:(result as any).cost.whole.cpu_s_per_s},
   closure:(result as any).receipts_closure?.bitwise}))
  await writeFile(target+'.partial',JSON.stringify({results},null,1))
 }
 await writeFile(target,JSON.stringify({kind:'c5x-standin',note:'TEST-ONLY Grid stand-in; previews, NOT evidence',
  exchange_law:law,counterexample,results},null,1))
 console.log(JSON.stringify({target}))
}
