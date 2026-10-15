/** TEST-ONLY Grid stand-in for the C5 native preview (PLATFORM lane). It is
 * NOT the World Grid Pack, is never registered in a Pack, the Runtime Hub or
 * the deployer (scripts/ is not shipped), and has no production use or
 * fallback role. It plays phase 1 of the ordered electrical join against one
 * `ld01-c5-host` child: for each exchange interval [t0, t1) it hands the
 * plant the committed boundary (energized, voltage, frequency) held over
 * the interval and takes back the plant's interval receipt (signed export
 * energy and auxiliary draws from the slice's IDAS quadratures). The Grid's
 * own integration (phase 2) is not modelled: the stand-in holds a stiff bus
 * at 50 Hz (in stop mode stepping it down 1 mHz each second), then drops it
 * dead (S3-D10's loss of offsite power) at a whole second.
 *
 * Usage: bun scripts/ld01-grid-standin.ts <ld01-c5-host> <receipt.json>
 * with the C5 environment (S3 packet, state, sections, ELEC packet). */
import {existsSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {hostError,spawnFramed,type Reply} from './ld01-host-spike'

const Op={load:1,command:3,exchange:12,status:10,close:9} as const
const text=new TextEncoder(),utf8=new TextDecoder()

export type Receipt={t0:number,t1:number,internalT:number,exportJ:number,unitDrawJ:number,reserveDrawJ:number,
 cumulativeExportJ:number,exportW:number,speedRadS:number,joined:boolean,offsiteLost:boolean,rcpSupported:number,
 arcHeatJ:number,rewound:boolean,steps:number,jacobians:number,residuals:number,errorFailures:number,
 convergenceFailures:number,restarts:number,heldS:number,forcedStops:number,signals:number[],events:unknown,
 roundTripS:number,handlerWallS:number,handlerCpuS:number}

/** One child hosting the S3 unit with ELEC's slice. */
export function spawnC5(binary:string){
 const host=spawnFramed(binary)
 return {
  pid:host.pid,exited:host.exited,
  load:async(state:string)=>JSON.parse(utf8.decode((await host.request(Op.load,text.encode(JSON.stringify({state})))).data)) as Record<string,unknown>,
  command:async(t:number,kind:number,index=0)=>{
   const p=new Uint8Array(13),v=new DataView(p.buffer);v.setFloat64(0,t,true);p[8]=kind;v.setUint32(9,index,true)
   return host.request(Op.command,p)
  },
  exchange:async(t1:number,stop:boolean,observe:boolean,energized:boolean,voltagePu:number,frequencyHz:number):Promise<Receipt>=>{
   const p=new Uint8Array(27),v=new DataView(p.buffer)
   v.setFloat64(0,t1,true);p[8]=stop?1:0;p[9]=observe?1:0;p[10]=energized?1:0;v.setFloat64(11,voltagePu,true);v.setFloat64(19,frequencyHz,true)
   const r:Reply=await host.request(Op.exchange,p),d=new DataView(r.data.buffer,r.data.byteOffset,r.data.byteLength)
   const f=(k:number)=>d.getFloat64(8*k,true),i=(k:number)=>Number(d.getBigInt64(112+8*k,true))
   const n=d.getUint32(176,true),signals=Array.from({length:n},(_,k)=>d.getFloat64(180+8*k,true))
   const at=180+8*n,m=d.getUint32(at,true)
   return {t0:f(0),t1:f(1),internalT:f(2),exportJ:f(3),unitDrawJ:f(4),reserveDrawJ:f(5),cumulativeExportJ:f(6),
    exportW:f(7),speedRadS:f(8),joined:f(9)===1,offsiteLost:f(10)===1,rcpSupported:f(11),arcHeatJ:f(12),rewound:f(13)===1,
    steps:i(0),jacobians:i(1),residuals:i(2),errorFailures:i(3),convergenceFailures:i(4),restarts:i(5),heldS:i(6),forcedStops:i(7),
    signals,events:m?JSON.parse(utf8.decode(r.data.slice(at+4,at+4+m))):null,
    roundTripS:r.roundTripS,handlerWallS:r.handlerWallS,handlerCpuS:r.handlerCpuS}
  },
  status:async()=>JSON.parse(utf8.decode((await host.request(Op.status)).data)) as Record<string,unknown>,
  close:async()=>{await host.request(Op.close);return host.exited},
 }
}

function quantiles(values:number[]){
 const s=[...values].sort((a,b)=>a-b),q=(p:number)=>s[Math.min(s.length-1,Math.floor(p*s.length))]??NaN
 return {n:s.length,p50:q(.5),p95:q(.95),p99:q(.99),max:s.at(-1)??NaN}
}

export type Scenario={cadenceS:number,stop:boolean,preLoopS:number,postLoopS:number,tripAfterLoopS:number,frequencySteps:boolean}

/** One LOOP sequence: stiff bus, then dead at t0 + preLoop (a whole second). */
async function sequence(binary:string,state:string,s:Scenario){
 const plant=spawnC5(binary),load=await plant.load(state),t0=load.t as number
 const tLoop=t0+s.preLoopS,tEnd=tLoop+s.postLoopS,n=Math.round((tEnd-t0)/s.cadenceS)
 // C5's turbine trip, declared (IC-PROT's field-supply-loss cause: 0.1 s
 // sampling + 0.1 s transport, as ELEC's LOOP probe declares it).
 await plant.command(tLoop+s.tripAfterLoopS,1)
 const receipts:Receipt[]=[]
 let refusal:string|null=null
 for(let k=1;k<=n;k++){
  const t1=k===n?tEnd:t0+k*s.cadenceS,tStart=t0+(k-1)*s.cadenceS
  const energized=tStart<tLoop-1e-9
  const second=Math.floor(tStart-t0+1e-9)
  const frequency=s.frequencySteps&&energized?50-0.001*second:50
  const observe=Math.abs(t1-t0-Math.round(t1-t0))<1e-9
  try{receipts.push(await plant.exchange(t1,s.stop,observe,energized,1,frequency))}
  catch(e){refusal=(e as Error).message;break}
 }
 const status=await plant.status()
 await plant.close()
 return {load,t0,tLoop,tEnd,receipts,refusal,status}
}

function analyse(s:Scenario,run:Awaited<ReturnType<typeof sequence>>){
 const r=run.receipts
 if(!r.length)return {scenario:s,refusal:run.refusal}
 // Telescoping: the interval receipts sum to the cumulative quadrature.
 let sum=0;for(const x of r)sum+=x.exportJ
 const first=r[0]!,last=r.at(-1)!
 const cumulative=last.cumulativeExportJ-(first.cumulativeExportJ-first.exportJ)
 // Held injection (today's Grid: the last committed MW held over the next
 // interval) against the receipt, per interval.
 let held=0,prevW=first.exportW
 const pre:number[]=[],loop:number[]=[]
 for(const x of r){
  const h=prevW*(x.t1-x.t0);held+=h
  ;(x.t0<run.tLoop-1e-9?pre:loop).push(h-x.exportJ)
  prevW=x.exportW
 }
 const overhead=r.map(x=>x.roundTripS-x.handlerWallS)
 const span=last.t1-first.t0
 const cpu=r.reduce((a,x)=>a+x.handlerCpuS,0)
 const events=r.filter(x=>x.events).map(x=>({t0:x.t0-run.t0,t1:x.t1-run.t0,events:x.events}))
 const perSecond=r.filter(x=>Math.abs(x.t1-run.t0-Math.round(x.t1-run.t0))<1e-9)
  .map(x=>({t_s:Math.round(x.t1-run.t0),cumulative_export_J:x.cumulativeExportJ,export_W:x.exportW,speed_rpm:x.speedRadS*30/Math.PI,
   joined:x.joined,offsite_lost:x.offsiteLost,rcp_supported:x.rcpSupported,released_W:x.signals[0],pzr_pt1_Pa:x.signals[1],
   steps:x.steps,jacobians:x.jacobians,restarts:x.restarts,held_s:x.heldS}))
 return {scenario:s,refusal:run.refusal,exchanges:r.length,reached_s:last.t1-run.t0,
  telescoping:{sum_of_receipts_J:sum,cumulative_J:cumulative,difference_J:sum-cumulative,bitwise:Object.is(sum,cumulative)},
  held_injection:{total_held_J:held,total_receipts_J:sum,error_J:held-sum,
   pre_loop_abs_error_J:pre.reduce((a,v)=>a+Math.abs(v),0),loop_and_after_abs_error_J:loop.reduce((a,v)=>a+Math.abs(v),0),
   worst_interval_J:Math.max(...[...pre,...loop].map(Math.abs))},
  auxiliary_J:{unit:r.reduce((a,x)=>a+x.unitDrawJ,0),reserve:r.reduce((a,x)=>a+x.reserveDrawJ,0)},
  overhead_us:quantiles(overhead.map(v=>1e6*v)),handler_cpu_ms:quantiles(r.map(x=>1e3*x.handlerCpuS)),
  handler_cpu_s_per_simulated_s:{all:cpu/span,
   pre_loop:r.filter(x=>x.t1<=run.tLoop+1e-9).reduce((a,x)=>a+x.handlerCpuS,0)/(run.tLoop-run.t0)},
  counts_end:{steps:last.steps,jacobians:last.jacobians,restarts:last.restarts,held_s:last.heldS,forced_stops:last.forcedStops,
   error_failures:last.errorFailures,convergence_failures:last.convergenceFailures},
  arc_heat_J:last.arcHeatJ,per_second:perSecond,events,load_cpu_s:run.load.cpu_s,max_rss_bytes:run.status.max_rss_bytes}
}

if(import.meta.main){
 const [binary,receiptPath]=process.argv.slice(2)
 if(!binary||!receiptPath)throw hostError('usage: bun scripts/ld01-grid-standin.ts <ld01-c5-host> <receipt.json>')
 if(existsSync(receiptPath))throw hostError('receipts are never overwritten: '+receiptPath)
 const state=process.env.LD01_S3_STATE
 if(!state)throw hostError('LD01_S3_STATE names KERN\'s saved S3 state')
 const base={preLoopS:10,postLoopS:6,tripAfterLoopS:0.2}
 const scenarios:Scenario[]=[
  {cadenceS:1,stop:true,frequencySteps:true,...base},
  {cadenceS:0.02,stop:true,frequencySteps:true,...base},
  {cadenceS:1,stop:false,frequencySteps:false,...base},
  {cadenceS:0.02,stop:false,frequencySteps:false,...base},
 ]
 const started=Bun.nanoseconds(),results:unknown[]=[],runs:Awaited<ReturnType<typeof sequence>>[]=[]
 for(const s of scenarios){
  const run=await sequence(binary,state,s);runs.push(run)
  const a=analyse(s,run);results.push(a)
  console.error(new Date().toISOString(),JSON.stringify({scenario:s,refusal:run.refusal,exchanges:run.receipts.length,
   telescoping:(a as {telescoping?:unknown}).telescoping,held:(a as {held_injection?:unknown}).held_injection,
   cpu:(a as {handler_cpu_s_per_simulated_s?:unknown}).handler_cpu_s_per_simulated_s,overhead:(a as {overhead_us?:unknown}).overhead_us}))
 }
 // Cadence independence at common whole seconds (bitwise where the step
 // sequence cannot depend on the exchange: no stops, no held changes).
 const common=(a:number,b:number)=>{
  const ra=runs[a]!,rb=runs[b]!,at=new Map(ra.receipts.map(x=>[Math.round((x.t1-ra.t0)*1000),x.cumulativeExportJ]))
  return rb.receipts.filter(x=>at.has(Math.round((x.t1-rb.t0)*1000))&&Math.abs(x.t1-rb.t0-Math.round(x.t1-rb.t0))<1e-9)
   .map(x=>{const v=at.get(Math.round((x.t1-rb.t0)*1000))!;return {t_s:Math.round(x.t1-rb.t0),a_J:v,b_J:x.cumulativeExportJ,difference_J:x.cumulativeExportJ-v,bitwise:Object.is(v,x.cumulativeExportJ)}})
 }
 const receipt={kind:'ld01-platform-c5-native-preview-NOT-EVIDENCE',binary,state,
  environment:{packet:process.env.LD01_OPERATING_HOT_SPINE_PACKET,elec:process.env.ELEC_PACKET,wiki:process.env.LD01_WIKI_ROOT,
   ic:process.env.LD01_IC_SECTION,pzr_control:process.env.LD01_PZR_CONTROL_SECTION},
  stand_in:'TEST-ONLY Grid stand-in: phase 1 of the ordered join only; stiff bus held per interval, dead bus at LOOP; no Grid integration',
  composition_note:'S3 composition (common/s3_unit.rs) without the frame driver clients: PZR control demand held, IC-PROT absent, C5 turbine trip declared at LOOP + 0.2 s',
  results,
  cadence_comparison:{stop_1s_vs_20ms:common(0,1),nostop_1s_vs_20ms:common(2,3),stop_vs_nostop_1s:common(0,2)},
  wall_s:(Bun.nanoseconds()-started)*1e-9,bun:Bun.version}
 await writeFile(receiptPath,JSON.stringify(receipt,null,1))
 console.error('wrote '+receiptPath)
}
