/** TEST-ONLY driver of the joined LD-01 unit host (PLATFORM lane, S5 host
 * on the joined spine). It spawns `ld01-joined-host` children, speaks their
 * framed stdin/stdout protocol in caller-driven exchanges and measures:
 * (a) a copy taken at a restart boundary during a 60 s turbine trip has a
 * bitwise-identical future; (b) two processes restored from one snapshot
 * reach byte-equal snapshots after 60 s; (c) restore cost and memory per
 * unit; and four concurrent units with staggered trips (CPU per unit).
 * Nothing here is registered in a Pack, the Runtime Hub or the deployer.
 *
 * Usage: bun scripts/ld01-joined-host.ts <host-binary> <receipt.json> [part]
 * with the S2 gate environment (packet, wiki, declaration, settled state);
 * part is `determinism` (a, b, c) or `four` (the concurrent run). */
import {createHash} from 'node:crypto'
import {existsSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {hostError,spawnFramed,type Reply} from './ld01-host-spike'

const Op={load:1,advance:2,command:3,snapshot:5,restore:6,abort:8,close:9,status:10,restart:11} as const
export const CommandKind={stop:0,turbineTrip:1,reactorTrip:2,stuckCluster:3} as const
const text=new TextEncoder(),utf8=new TextDecoder()
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
/** A snapshot's header (JSON) and body (y, y' bits) digests. */
const parts=(b:Uint8Array)=>{const n=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(8,true)
 return {header_sha256:sha(b.slice(12,12+n)),body_sha256:sha(b.slice(12+n)),header:JSON.parse(utf8.decode(b.slice(12,12+n))) as unknown}}

export type JoinedAdvance={t:number,internalT:number,steps:number,residuals:number,jacobians:number,
 nonlinearIterations:number,errorFailures:number,convergenceFailures:number,restarts:number,signals:number[],
 roundTripS:number,handlerWallS:number,handlerCpuS:number}

/** One child hosting one joined unit. */
export function spawnJoined(binary:string){
 const host=spawnFramed(binary)
 const json=(r:Reply)=>JSON.parse(utf8.decode(r.data)) as Record<string,unknown>
 return {
  pid:host.pid,exited:host.exited,kill:host.kill,
  load:async(settled:string)=>json(await host.request(Op.load,text.encode(JSON.stringify({settled})))),
  advance:async(target:number,stop:boolean,observe:boolean):Promise<JoinedAdvance>=>{
   const p=new Uint8Array(10);new DataView(p.buffer).setFloat64(0,target,true);p[8]=stop?1:0;p[9]=observe?1:0
   const r=await host.request(Op.advance,p),v=new DataView(r.data.buffer,r.data.byteOffset,r.data.byteLength)
   const i=(k:number)=>Number(v.getBigInt64(16+8*k,true)),n=v.getUint32(72,true)
   return {t:v.getFloat64(0,true),internalT:v.getFloat64(8,true),steps:i(0),residuals:i(1),jacobians:i(2),
    nonlinearIterations:i(3),errorFailures:i(4),convergenceFailures:i(5),restarts:i(6),
    signals:Array.from({length:n},(_,k)=>v.getFloat64(76+8*k,true)),
    roundTripS:r.roundTripS,handlerWallS:r.handlerWallS,handlerCpuS:r.handlerCpuS}
  },
  command:async(t:number,kind:number,cluster=0)=>{
   const p=new Uint8Array(13),v=new DataView(p.buffer);v.setFloat64(0,t,true);p[8]=kind;v.setUint32(9,cluster,true)
   return host.request(Op.command,p)
  },
  snapshot:async()=>{const r=await host.request(Op.snapshot);return {...r,blob:r.data}},
  restore:async(blob:Uint8Array)=>{const r=await host.request(Op.restore,blob);return {...r,reply:json(r)}},
  restart:async()=>{const r=await host.request(Op.restart);return {...r,reply:json(r)}},
  status:async()=>json(await host.request(Op.status)),
  close:async()=>{await host.request(Op.close);return host.exited},
 }
}
export type JoinedHost=ReturnType<typeof spawnJoined>

/** Exchanges every `dt` from `from` to `to` (the last one a stop when
 * `stopAtEnd`), observing every `observeEvery` exchanges. */
async function drive(hosts:JoinedHost[],from:number,to:number,dt:number,stopAtEnd:boolean,observeEvery:number){
 const n=Math.round((to-from)/dt),trace:JoinedAdvance[][]=hosts.map(()=>[]),wall:number[]=[]
 for(let k=1;k<=n;k++){
  const target=k===n?to:from+k*dt,stop=stopAtEnd&&k===n,observe=k%observeEvery===0||k===n
  const s=Bun.nanoseconds()
  const replies=await Promise.all(hosts.map(h=>h.advance(target,stop,observe)))
  wall.push((Bun.nanoseconds()-s)*1e-9)
  replies.forEach((r,i)=>{if(observe)trace[i]!.push(r)})
 }
 return {trace,wall}
}
const sameBits=(a:number[],b:number[])=>a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]))

function environment(){
 const settled=process.env.LD01_S2_SETTLED_STATE
 for(const k of ['LD01_OPERATING_HOT_SPINE_PACKET','LD01_WIKI_ROOT','LD01_S2_DECLARATION'])if(!process.env[k])throw hostError(k+' is required')
 if(!settled)throw hostError('LD01_S2_SETTLED_STATE names the settled state')
 return settled
}
const log=(m:string)=>console.error(new Date().toISOString()+' '+m)
const loadAverage=async()=>(await Bun.$`sysctl -n vm.loadavg`.nothrow().text()).trim()

async function determinism(binary:string,settled:string){
 const r:Record<string,unknown>={}
 const A=spawnJoined(binary)
 const load=await A.load(settled);r.load=load
 const t0=load.t as number,dt=0.1,tc=t0+1
 log(`A loaded at t0=${t0} s in ${(load.wall_s as number).toFixed(2)} s`)
 // (a) A: turbine trip at t0, exchanges every 0.1 s, a stop at t_c, the
 // snapshot there, the exact consistent restart in place, on to t0 + 60.
 // Stops are prospective: scheduled before the integrator can pass them.
 const t60=t0+60
 await A.command(t0,CommandKind.turbineTrip)
 await A.command(tc,CommandKind.stop)
 await A.command(t60,CommandKind.stop)
 // The copies will also stop at t_c + 60; the source schedules the same
 // stop so the snapshots' schedules (part of the truth) agree at t0 + 60.
 await A.command(tc+60,CommandKind.stop)
 const before=await drive([A],t0,tc,dt,true,10)
 const snap=await A.snapshot(),Sc=snap.blob
 const restartA=await A.restart()
 r.snapshot={t_s:tc,bytes:Sc.length,sha256:sha(Sc),handler_wall_s:snap.handlerWallS,round_trip_s:snap.roundTripS}
 r.source_restart=restartA.reply
 log(`snapshot at t_c=${tc}: ${Sc.length} B; source restart ${JSON.stringify(restartA.reply)}`)
 // B and C: two fresh processes restored from the one snapshot.
 const B=spawnJoined(binary),C=spawnJoined(binary)
 const [rb,rc]=await Promise.all([B.restore(Sc),C.restore(Sc)])
 r.restores=[rb.reply,rc.reply].map((x,i)=>({...x,round_trip_s:[rb,rc][i]!.roundTripS}))
 log(`B, C restored: ${JSON.stringify(r.restores)}`)
 // All three exchange identically from t_c to t0 + 60 (a stop there, in
 // the snapshot's schedule); B and C also stop at t_c + 60.
 await Promise.all([B,C].map(h=>h.command(tc+60,CommandKind.stop)))
 const run=await drive([A,B,C],tc,t60,dt,true,10)
 const [sa,sb,sc]=await Promise.all([A.snapshot(),B.snapshot(),C.snapshot()] as const)
 const signalsEqual=run.trace[0]!.every((x,i)=>sameBits(x.signals,run.trace[1]![i]!.signals))
 const [pa,pb]=[parts(sa.blob),parts(sb.blob)]
 r.a_copy_at_restart_boundary={t_copy_s:tc,until_s:t60,
  source_sha256:sha(sa.blob),copy_sha256:sha(sb.blob),snapshots_byte_equal:sha(sa.blob)===sha(sb.blob),
  body_equal:pa.body_sha256===pb.body_sha256,header_equal:pa.header_sha256===pb.header_sha256,
  headers:pa.header_sha256===pb.header_sha256?undefined:[pa.header,pb.header],
  observed_signals_bitwise_equal:signalsEqual,observations:run.trace[0]!.length,
  source_counts:run.trace[0]!.at(-1),copy_counts:run.trace[1]!.at(-1)}
 log('(a) '+JSON.stringify(r.a_copy_at_restart_boundary))
 // (b) B and C on to t_c + 60 s after their restore.
 const run2=await drive([B,C],t60,tc+60,dt,true,10)
 const [sb2,sc2]=await Promise.all([B.snapshot(),C.snapshot()] as const)
 r.b_two_processes_one_snapshot={restored_at_s:tc,until_s:tc+60,b_sha256:sha(sb2.blob),c_sha256:sha(sc2.blob),
  byte_equal:sha(sb2.blob)===sha(sc2.blob),also_equal_at_t0_plus_60:sha(sb.blob)===sha(sc.blob),
  b_counts:run2.trace[0]!.at(-1),c_counts:run2.trace[1]!.at(-1)}
 log('(b) '+JSON.stringify(r.b_two_processes_one_snapshot))
 // The trip's trace (A) for the record: power, PT1, SG pressures, rods.
 r.trip_trace=[...before.trace[0]!,...run.trace[0]!].map(x=>({t_s:x.t-t0,signals:x.signals,steps:x.steps,jacobians:x.jacobians,restarts:x.restarts,
  handler_cpu_s:x.handlerCpuS}))
 // (c) restore cost and memory: three more restores in one process, the
 // resident set after each, and every process's state at the end.
 const D=spawnJoined(binary),more:unknown[]=[]
 for(let i=0;i<3;i++){const x=await D.restore(Sc);more.push({...x.reply,round_trip_s:x.roundTripS})}
 r.c_restore_cost={in_fresh_processes:r.restores,repeated_in_one_process:more,
  status_end:await Promise.all([A,B,C,D].map(h=>h.status()))}
 log('(c) '+JSON.stringify(more))
 await Promise.all([A,B,C,D].map(h=>h.close()))
 return r
}

async function four(binary:string,settled:string){
 const r:Record<string,unknown>={}
 const hosts=[0,1,2,3].map(()=>spawnJoined(binary))
 const s0=Bun.nanoseconds()
 const loads=await Promise.all(hosts.map(h=>h.load(settled)))
 r.loads=loads.map(l=>({cpu_s:l.cpu_s,wall_s:l.wall_s}))
 r.load_wall_s=(Bun.nanoseconds()-s0)*1e-9
 const t0=loads[0]!.t as number,span=80,dt=0.1
 // Trips staggered by LD01_FOUR_STAGGER_S (default 5 s; 0 = one grid event
 // tripping every unit at once, S8's four-unit burst).
 const stagger=Number(process.env.LD01_FOUR_STAGGER_S??'5')
 if(!(stagger>=0))throw hostError('LD01_FOUR_STAGGER_S must be a nonnegative number')
 const trips=hosts.map((_,k)=>t0+2+stagger*k)
 await Promise.all(hosts.map((h,k)=>h.command(trips[k]!,CommandKind.turbineTrip)))
 const cpu0=await Promise.all(hosts.map(h=>h.status()))
 const parent0=process.cpuUsage(),w0=Bun.nanoseconds()
 // Per simulated second: each unit's handler CPU and the lockstep wall.
 const perSecond:{t_s:number,wall_s:number,unit_cpu_s:number[]}[]=[]
 let t=t0
 for(let s=1;s<=span;s++){
  const sw=Bun.nanoseconds(),cpu=[0,0,0,0]
  for(let k=1;k<=10;k++){
   const target=k===10?t0+s:t+k*dt
   const replies=await Promise.all(hosts.map(h=>h.advance(target,false,k===10)))
   replies.forEach((x,i)=>{cpu[i]!+=x.handlerCpuS})
  }
  t=t0+s
  perSecond.push({t_s:s,wall_s:(Bun.nanoseconds()-sw)*1e-9,unit_cpu_s:cpu})
  if(s%10===0)log(`four: ${s} s simulated, wall ${((Bun.nanoseconds()-w0)*1e-9).toFixed(1)} s`)
 }
 const wall=(Bun.nanoseconds()-w0)*1e-9,parent=process.cpuUsage(parent0)
 const cpu1=await Promise.all(hosts.map(h=>h.status()))
 r.trips_s_after_t0=trips.map(x=>x-t0)
 r.span_s=span
 r.wall_s=wall
 r.realtime_factor=span/wall
 r.parent_cpu_s=(parent.user+parent.system)*1e-6
 r.units=hosts.map((h,i)=>({pid:h.pid,process_cpu_s:(cpu1[i]!.process_cpu_s as number)-(cpu0[i]!.process_cpu_s as number),
  cpu_s_per_simulated_s:((cpu1[i]!.process_cpu_s as number)-(cpu0[i]!.process_cpu_s as number))/span,
  max_rss_bytes:cpu1[i]!.max_rss_bytes,counts:cpu1[i]!.counts}))
 r.aggregate_cpu_s_per_simulated_s=(r.units as {cpu_s_per_simulated_s:number}[]).reduce((a,u)=>a+u.cpu_s_per_simulated_s,0)
 r.per_second=perSecond
 // Real-time pacing replayed on the measured lockstep walls: the lag after
 // each simulated second when every second may use at most one wall second
 // plus the lag carried (no physics skipped).
 let lag=0,maxLag=0
 for(const p of perSecond){lag=Math.max(0,lag+p.wall_s-1);maxLag=Math.max(maxLag,lag)}
 r.realtime_replay={max_lag_s:maxLag,final_lag_s:lag,rule:'lag_k = max(0, lag_{k-1} + wall_k - 1 s) over the lockstep per-second walls'}
 const worst=perSecond.reduce((a,p)=>p.wall_s>a.wall_s?p:a)
 r.worst_second={...worst}
 log(`four: ${span} s in ${wall.toFixed(1)} s wall (RT factor ${(span/wall).toFixed(2)}), aggregate ${(r.aggregate_cpu_s_per_simulated_s as number).toFixed(3)} CPU-s/s`)
 await Promise.all(hosts.map(h=>h.close()))
 return r
}

if(import.meta.main){
 const [binary,receiptPath,part='determinism']=process.argv.slice(2)
 if(!binary||!receiptPath)throw hostError('usage: bun scripts/ld01-joined-host.ts <host-binary> <receipt.json> [determinism|four]')
 if(existsSync(receiptPath))throw hostError('receipts are never overwritten: '+receiptPath)
 const settled=environment(),started=Bun.nanoseconds()
 const receipt:Record<string,unknown>={kind:`ld01-platform-joined-host-${part}-NOT-EVIDENCE`,binary,
  packet:process.env.LD01_OPERATING_HOT_SPINE_PACKET,wiki:process.env.LD01_WIKI_ROOT,declaration:process.env.LD01_S2_DECLARATION,
  settled,bun:Bun.version,platform:process.platform,arch:process.arch,load_average_start:await loadAverage()}
 receipt.result=part==='four'?await four(binary,settled):await determinism(binary,settled)
 receipt.wall_s=(Bun.nanoseconds()-started)*1e-9
 receipt.load_average_end=await loadAverage()
 await writeFile(receiptPath,JSON.stringify(receipt,null,1))
 log('wrote '+receiptPath)
}
