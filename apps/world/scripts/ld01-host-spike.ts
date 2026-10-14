/** TEST-ONLY driver of the LD-01 host spike (PLATFORM lane, S2-D10/S2-D15).
 * It spawns `ld01-host-spike` children (operating/host-spike), speaks their
 * framed stdin/stdout protocol and measures per-exchange overhead at 10, 20
 * and 50 Hz, snapshot and restore over the pipe, crash behaviour, four
 * concurrent units, and the same loop in process through `bun:ffi` (main
 * thread and a Worker). Nothing here is registered in a Pack, the Runtime
 * Hub or the deployer; the deployer ships only `src/**`.
 *
 * Usage: bun scripts/ld01-host-spike.ts <host-release-dir> <receipt.json>
 * with LD01_OPERATING_HOT_SPINE_PACKET and LD01_WIKI_ROOT set. */
import {dlopen,FFIType,suffix,type Pointer} from 'bun:ffi'
import {existsSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export const AdvanceMode={interpolate:0,stop:1,restart:2,rebuild:3} as const
export type AdvanceModeCode=typeof AdvanceMode[keyof typeof AdvanceMode]
export type HostConfig={packet:string,wiki:string}
export type Counts={steps:number,residuals:number,jacobians:number,nonlinearIterations:number,errorFailures:number,convergenceFailures:number,restarts:number,rebuilds:number}
export type Reply={handlerWallS:number,handlerCpuS:number,data:Uint8Array,roundTripS:number}
export type AdvanceReply=Reply&{t:number,internalT:number,counts:Counts,signals:Float64Array}
export type HostExit={exitCode:number|null,signalCode:string|null}

const Op={load:1,advance:2,command:3,observe:4,snapshot:5,restore:6,ping:7,abort:8,close:9,status:10} as const

/** Explicit refusal from the host (status 1) or the end of the child. */
export const hostError=(message:string)=>Object.assign(new Error(message),{name:'LD01HostError'})

function frame(op:number,seq:number,payload:Uint8Array){
 const out=new Uint8Array(9+payload.length),view=new DataView(out.buffer)
 view.setUint32(0,5+payload.length,true);out[4]=op;view.setUint32(5,seq,true);out.set(payload,9)
 return out
}
function f64Bytes(values:number[]){const out=new Uint8Array(8*values.length),v=new DataView(out.buffer);values.forEach((x,i)=>v.setFloat64(8*i,x,true));return out}
function concat(parts:Uint8Array[]){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length}return out}
const text=new TextEncoder(),utf8=new TextDecoder()

/** One child process hosting one unit. Every request resolves with the
 * host's reply or rejects with a HostError naming the refusal or the
 * child's exit; nothing is retried. */
export function spawnHost(binary:string){
 const child=Bun.spawn([binary],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 const pending=new Map<number,{resolve:(r:Reply)=>void,reject:(e:Error)=>void,sent:number}>()
 let seq=0,ended:HostExit|null=null,buffer:Uint8Array=new Uint8Array(0),stderr=''
 const failAll=(reason:string)=>{for(const [,p] of pending)p.reject(hostError(reason));pending.clear()}
 const reading=(async()=>{
  for await(const chunk of child.stdout as ReadableStream<Uint8Array>){
   buffer=buffer.length?concat([buffer,chunk]):chunk
   while(buffer.length>=4){
    const view=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength),length=view.getUint32(0,true)
    if(buffer.length<4+length)break
    const status=buffer[4]!,id=view.getUint32(5,true),body=buffer.slice(9,4+length)
    buffer=buffer.slice(4+length)
    const p=pending.get(id);if(!p)throw hostError('reply to an unknown request '+id)
    pending.delete(id)
    const roundTripS=(Bun.nanoseconds()-p.sent)*1e-9
    if(status!==0){p.reject(hostError(utf8.decode(body)));continue}
    const b=new DataView(body.buffer,body.byteOffset,body.byteLength)
    p.resolve({handlerWallS:b.getFloat64(0,true),handlerCpuS:b.getFloat64(8,true),data:body.slice(16),roundTripS})
   }
  }
 })()
 const stderrDone=(async()=>{for await(const chunk of child.stderr as ReadableStream<Uint8Array>)stderr+=utf8.decode(chunk)})()
 const exited=(async()=>{
  await child.exited;await reading.catch(()=>undefined);await stderrDone
  ended={exitCode:child.exitCode,signalCode:child.signalCode}
  failAll(`LD-01 host ${child.pid} ended (exit ${child.exitCode}, signal ${child.signalCode}): ${stderr.trim().split('\n').slice(-2).join(' | ')}`)
  return ended
 })()
 const request=(op:number,payload:Uint8Array=new Uint8Array(0))=>new Promise<Reply>((resolve,reject)=>{
  if(ended){reject(hostError('LD-01 host already ended'));return}
  const id=++seq;pending.set(id,{resolve,reject,sent:Bun.nanoseconds()})
  child.stdin.write(frame(op,id,payload));child.stdin.flush()
 })
 const parseAdvance=(r:Reply):AdvanceReply=>{
  const v=new DataView(r.data.buffer,r.data.byteOffset,r.data.byteLength),i=(k:number)=>Number(v.getBigInt64(16+8*k,true))
  const n=v.getUint32(80,true),signals=new Float64Array(n)
  for(let k=0;k<n;k++)signals[k]=v.getFloat64(84+8*k,true)
  return {...r,t:v.getFloat64(0,true),internalT:v.getFloat64(8,true),signals,
   counts:{steps:i(0),residuals:i(1),jacobians:i(2),nonlinearIterations:i(3),errorFailures:i(4),convergenceFailures:i(5),restarts:i(6),rebuilds:i(7)}}
 }
 const json=(r:Reply)=>JSON.parse(utf8.decode(r.data)) as Record<string,unknown>
 return {
  pid:child.pid,exited,
  kill:(signal:NodeJS.Signals)=>child.kill(signal),
  load:async(config:HostConfig)=>json(await request(Op.load,text.encode(JSON.stringify(config)))),
  advance:async(target:number,mode:AdvanceModeCode,observe:boolean)=>{
   const p=new Uint8Array(10);new DataView(p.buffer).setFloat64(0,target,true);p[8]=mode;p[9]=observe?1:0
   return parseAdvance(await request(Op.advance,p))
  },
  command:async(t:number,rotor:number,supported:boolean)=>{
   const p=new Uint8Array(13),v=new DataView(p.buffer);v.setFloat64(0,t,true);v.setUint32(8,rotor,true);p[12]=supported?1:0
   return request(Op.command,p)
  },
  snapshot:async()=>{const r=await request(Op.snapshot);return {...r,blob:r.data}},
  restore:async(config:HostConfig,blob:Uint8Array)=>{
   const c=text.encode(JSON.stringify(config)),head=new Uint8Array(4);new DataView(head.buffer).setUint32(0,c.length,true)
   const r=await request(Op.restore,concat([head,c,blob]));return {...r,reply:json(r)}
  },
  ping:(bytes:Uint8Array)=>request(Op.ping,bytes),
  abort:()=>request(Op.abort),
  status:async()=>json(await request(Op.status)),
  close:async()=>{await request(Op.close);return exited},
 }
}
export type Host=ReturnType<typeof spawnHost>

function quantiles(values:number[]){
 const s=[...values].sort((a,b)=>a-b),q=(p:number)=>s[Math.min(s.length-1,Math.floor(p*s.length))]!
 return {n:s.length,mean:s.reduce((a,b)=>a+b,0)/Math.max(1,s.length),p50:q(.5),p95:q(.95),p99:q(.99),max:s[s.length-1]??NaN}
}
const us=(seconds:number[])=>quantiles(seconds.map(s=>1e6*s))

/** The C ABI surface of the spike's cdylib. */
function openLibrary(directory:string){
 return dlopen(join(directory,`libleitbild_ld01_host_spike.${suffix}`),{
  ld01_spike_noop:{args:[FFIType.f64],returns:FFIType.f64},
  ld01_spike_restore:{args:[FFIType.ptr,FFIType.u64,FFIType.ptr,FFIType.u64],returns:FFIType.ptr},
  ld01_spike_advance:{args:[FFIType.ptr,FFIType.f64,FFIType.u8,FFIType.ptr,FFIType.u64],returns:FFIType.i32},
  ld01_spike_last_error:{args:[FFIType.ptr,FFIType.u64],returns:FFIType.u64},
  ld01_spike_close:{args:[FFIType.ptr],returns:FFIType.void},
  ld01_spike_abort:{args:[],returns:FFIType.void},
 })
}
type Library=ReturnType<typeof openLibrary>
function ffiUnit(library:Library,config:HostConfig,blob:Uint8Array){
 const c=text.encode(JSON.stringify(config))
 const unit=library.symbols.ld01_spike_restore(c,c.length,blob,blob.length)
 const lastError=()=>{const b=new Uint8Array(4096);const n=Number(library.symbols.ld01_spike_last_error(b,b.length));return utf8.decode(b.slice(0,n))}
 if(!unit)throw hostError('ffi restore: '+lastError())
 const out=new Float64Array(12)
 return {
  advance:(target:number,mode:AdvanceModeCode,observe:boolean)=>{
   const n=library.symbols.ld01_spike_advance(unit,target,mode,out,observe?out.length:2)
   if(n<0)throw hostError('ffi advance: '+lastError())
   return out
  },
  close:()=>library.symbols.ld01_spike_close(unit as Pointer),
 }
}

type ExchangeResult={hz:number,mode:string,observe:boolean,paced:boolean,exchanges:number,simulated_s:number,
 round_trip_us:ReturnType<typeof quantiles>,handler_wall_us:ReturnType<typeof quantiles>,overhead_us:ReturnType<typeof quantiles>,
 lateness_us:ReturnType<typeof quantiles>|null,child_handler_cpu_s_per_s:number,parent_cpu_s_per_s:number,wall_s:number,steps:number}

/** `seconds` of simulated time in exchanges at `hz`, back to back (max
 * pace) or paced at real time. Overhead = round trip - handler wall. */
async function exchanges(host:Host,start:number,hz:number,seconds:number,mode:AdvanceModeCode,observe:boolean,paced:boolean):Promise<ExchangeResult>{
 const h=1/hz,n=Math.round(seconds*hz),rtt:number[]=[],handler:number[]=[],over:number[]=[],late:number[]=[]
 let childCpu=0,steps0=-1,steps1=0
 const cpu0=process.cpuUsage(),wall0=Bun.nanoseconds()
 for(let k=1;k<=n;k++){
  if(paced){
   const deadline=wall0+k*h*1e9,now=Bun.nanoseconds()
   if(deadline>now)await Bun.sleep((deadline-now)*1e-6)
   late.push((Bun.nanoseconds()-deadline)*1e-9)
  }
  const r=await host.advance(start+k*h,mode,observe)
  if(steps0<0)steps0=r.counts.steps
  steps1=r.counts.steps
  rtt.push(r.roundTripS);handler.push(r.handlerWallS);over.push(r.roundTripS-r.handlerWallS);childCpu+=r.handlerCpuS
 }
 const cpu=process.cpuUsage(cpu0),wall=(Bun.nanoseconds()-wall0)*1e-9
 return {hz,mode:Object.keys(AdvanceMode).find(k=>AdvanceMode[k as keyof typeof AdvanceMode]===mode)!,observe,paced,exchanges:n,simulated_s:seconds,
  round_trip_us:us(rtt),handler_wall_us:us(handler),overhead_us:us(over),lateness_us:paced?us(late):null,
  child_handler_cpu_s_per_s:childCpu/seconds,parent_cpu_s_per_s:(cpu.user+cpu.system)*1e-6/seconds,wall_s:wall,steps:steps1-steps0}
}

function environment(){
 const packet=process.env.LD01_OPERATING_HOT_SPINE_PACKET,wiki=process.env.LD01_WIKI_ROOT
 if(!packet||!wiki)throw Error('LD01_OPERATING_HOT_SPINE_PACKET and LD01_WIKI_ROOT name the packet and the wiki')
 return {packet,wiki}
}

/** Worker side of the Worker + bun:ffi comparison: restore one unit in
 * this thread and answer advance requests by postMessage. */
function serveWorker(){
 const scope=globalThis as unknown as {onmessage:((e:MessageEvent)=>void)|null,postMessage:(m:unknown)=>void}
 let unit:ReturnType<typeof ffiUnit>|null=null
 scope.onmessage=(e:MessageEvent)=>{
  const m=e.data as {kind:'open',directory:string,config:HostConfig,blob:Uint8Array}|{kind:'advance',target:number,mode:AdvanceModeCode,observe:boolean}|{kind:'close'}
  if(m.kind==='open'){unit=ffiUnit(openLibrary(m.directory),m.config,m.blob);scope.postMessage({kind:'opened'})}
  else if(m.kind==='advance'){const t0=Bun.nanoseconds();const out=unit!.advance(m.target,m.mode,m.observe);scope.postMessage({kind:'advanced',t:out[0],steps:out[1],handlerS:(Bun.nanoseconds()-t0)*1e-9,signals:m.observe?Array.from(out.slice(2)):[]})}
  else{unit?.close();unit=null;scope.postMessage({kind:'closed'})}
 }
}

async function main(directory:string,receiptPath:string){
 if(existsSync(receiptPath))throw Error('receipts are never overwritten: '+receiptPath)
 const config=environment(),binary=join(directory,'ld01-host-spike'),started=Bun.nanoseconds()
 const receipt:Record<string,unknown>={kind:'ld01-platform-host-spike-protocol-NOT-EVIDENCE',binary,config,
  bun:Bun.version,platform:process.platform,arch:process.arch,
  load_average_start:(await Bun.$`sysctl -n vm.loadavg`.nothrow().text()).trim()}
 const log=(m:string)=>console.error(new Date().toISOString()+' '+m)

 // Spawn, load, settle to a quiet state (S1 settles at 46 s), snapshot.
 const spawnStart=Bun.nanoseconds(),host=spawnHost(binary)
 const loaded=await host.load(config)
 receipt.spawn_and_load_s=(Bun.nanoseconds()-spawnStart)*1e-9
 receipt.load=loaded
 let t=0
 for(;t<60;)await host.advance(++t,AdvanceMode.interpolate,false)
 const snap=await host.snapshot(),blob=snap.blob
 receipt.snapshot={bytes:blob.length,round_trip_us:1e6*snap.roundTripS,handler_us:1e6*snap.handlerWallS,t}
 log(`loaded and settled to ${t} s; snapshot ${blob.length} B`)

 // Pure IPC: ping round trips with an 8 B, 4 KB and a joined-sized 446 KB payload.
 const pings:Record<string,unknown>={}
 for(const size of [8,4096,446472]){
  const payload=new Uint8Array(size).fill(7),rtt:number[]=[],count=size>100000?200:3000
  for(let i=0;i<count;i++)rtt.push((await host.ping(payload)).roundTripS)
  pings[`${size}B`]=us(rtt.slice(Math.floor(count/10)))
 }
 receipt.ping=pings
 log('ping '+JSON.stringify(pings))

 // Exchange loops from the quiet state: restore before each, 10 s each.
 const results:ExchangeResult[]=[]
 for(const paced of [false,true])for(const hz of [10,20,50])for(const [mode,observe] of [[AdvanceMode.stop,true],[AdvanceMode.stop,false],[AdvanceMode.interpolate,true]] as const){
  if(paced&&!(mode===AdvanceMode.stop&&observe))continue
  await host.restore(config,blob)
  const r=await exchanges(host,t,hz,10,mode,observe,paced)
  results.push(r)
  log(`${paced?'paced':'max'} ${hz} Hz ${r.mode}${observe?'+obs':''}: rtt p50 ${r.round_trip_us.p50.toFixed(0)} us, overhead p50 ${r.overhead_us.p50.toFixed(0)} p99 ${r.overhead_us.p99.toFixed(0)} us, child ${r.child_handler_cpu_s_per_s.toFixed(4)} parent ${r.parent_cpu_s_per_s.toFixed(4)} CPU-s/s`)
 }
 receipt.exchanges=results

 // Restore over the pipe, in place and into a fresh child.
 const restores:unknown[]=[]
 for(let i=0;i<5;i++){const r=await host.restore(config,blob);restores.push({round_trip_s:r.roundTripS,handler_wall_s:r.handlerWallS,handler_cpu_s:r.handlerCpuS})}
 const fresh0=Bun.nanoseconds(),fresh=spawnHost(binary),freshRestore=await fresh.restore(config,blob)
 const freshFirst=await fresh.advance(t+0.02,AdvanceMode.stop,true)
 receipt.restore={in_place:restores,fresh_child:{spawn_to_restored_s:(Bun.nanoseconds()-fresh0)*1e-9,restore_handler_wall_s:freshRestore.handlerWallS,
  restore_handler_cpu_s:freshRestore.handlerCpuS,first_exchange_s:freshFirst.roundTripS,report:freshRestore.reply.report}}
 log('restore '+JSON.stringify(receipt.restore))

 // Determinism across processes: two children restore the same snapshot,
 // run 10 s of 50 Hz stop exchanges, and snapshot again: byte-equal?
 await Promise.all([host,fresh].map(h=>h.restore(config,blob)))
 await exchanges(host,t,50,10,AdvanceMode.stop,false,false)
 await exchanges(fresh,t,50,10,AdvanceMode.stop,false,false)
 const [a,b]=[(await host.snapshot()).blob,(await fresh.snapshot()).blob]
 receipt.cross_process_determinism={after_s:10,hz:50,snapshot_bytes_equal:a.length===b.length&&a.every((x,i)=>x===b[i])}
 log('determinism '+JSON.stringify(receipt.cross_process_determinism))

 // A prospective command off the exchange grid: RCP 0 loses motive supply
 // at t + 0.37 s while the unit exchanges every 20 ms.
 await host.restore(config,blob)
 await host.command(t+0.37,0,false)
 const trace:unknown[]=[]
 for(let k=1;k<=100;k++){
  const r=await host.advance(t+k*0.02,AdvanceMode.stop,true)
  if(k%5===0||(k>=18&&k<=20))trace.push({t:r.t,restarts:r.counts.restarts,rcp0_omega:r.signals[5],rcp1_omega:r.signals[6],loop_a_kg_s:r.signals[3],round_trip_us:1e6*r.roundTripS})
 }
 receipt.command={applied_at_s:t+0.37,exchange_s:0.02,trace}
 log('command trace '+JSON.stringify(trace.slice(0,6)))

 // Four concurrent units (one child each), 50 Hz stop exchanges, max pace.
 const four=[host,fresh,spawnHost(binary),spawnHost(binary)]
 await Promise.all(four.map(h=>h.restore(config,blob)))
 const per:number[]=[],cpu0=process.cpuUsage(),w0=Bun.nanoseconds()
 for(let k=1;k<=500;k++){const s=Bun.nanoseconds();await Promise.all(four.map(h=>h.advance(t+k*0.02,AdvanceMode.stop,true)));per.push((Bun.nanoseconds()-s)*1e-9)}
 const cpu4=process.cpuUsage(cpu0)
 const childCpu=await Promise.all(four.map(h=>h.status()))
 receipt.four_units={hz:50,simulated_s:10,exchange_wall_us:us(per),wall_s:(Bun.nanoseconds()-w0)*1e-9,parent_cpu_s:(cpu4.user+cpu4.system)*1e-6,child_process_cpu_s:childCpu.map(c=>c.process_cpu_s)}
 log('four units '+JSON.stringify(receipt.four_units))

 // Crash behaviour. (a) A native abort while idle; (b) SIGKILL during a
 // long advance; then recovery into a new child from the last snapshot.
 const crashes:Record<string,unknown>={}
 const victim=four[2]!,sent=Bun.nanoseconds()
 const abort=await victim.abort().then(()=>'resolved',(e:Error)=>e.message)
 crashes.abort={detected_after_us:(Bun.nanoseconds()-sent)*1e-3,rejection:abort,exit:await victim.exited}
 const killed=four[3]!
 const long=killed.advance(t+5000,AdvanceMode.interpolate,false).then(()=>'resolved',(e:Error)=>e.message)
 await Bun.sleep(30)
 const killAt=Bun.nanoseconds();killed.kill('SIGKILL')
 const rejection=await long
 crashes.sigkill_during_advance={detected_after_us:(Bun.nanoseconds()-killAt)*1e-3,rejection,exit:await killed.exited}
 const recover0=Bun.nanoseconds(),replacement=spawnHost(binary)
 await replacement.restore(config,blob)
 const resumed=await replacement.advance(t+0.02,AdvanceMode.stop,true)
 crashes.recovery={spawn_restore_first_exchange_s:(Bun.nanoseconds()-recover0)*1e-9,resumed_t:resumed.t}
 const others=await Promise.all([host,fresh].map(h=>h.advance(t+10.04,AdvanceMode.stop,false).then(r=>r.t,(e:Error)=>e.message)))
 crashes.other_units_unaffected=others
 receipt.crashes=crashes
 log('crashes '+JSON.stringify(crashes))

 // In process through bun:ffi on the main thread, then in a Worker.
 const library=openLibrary(directory)
 const noop:number[]=[];let x=0
 for(let r=0;r<5;r++){const s=Bun.nanoseconds();for(let i=0;i<1_000_000;i++)x=library.symbols.ld01_spike_noop(x);noop.push((Bun.nanoseconds()-s)/1e6)}
 const ffi=ffiUnit(library,config,blob),ffiWall:number[]=[],ffiCpu0=process.cpuUsage()
 for(let k=1;k<=500;k++){const s=Bun.nanoseconds();ffi.advance(t+k*0.02,AdvanceMode.stop,true);ffiWall.push((Bun.nanoseconds()-s)*1e-9)}
 const ffiCpu=process.cpuUsage(ffiCpu0);ffi.close()
 const worker=new Worker(import.meta.url)
 const ask=(m:unknown)=>new Promise<Record<string,unknown>>(resolve=>{worker.onmessage=(e:MessageEvent)=>resolve(e.data as Record<string,unknown>);worker.postMessage(m)})
 await ask({kind:'open',directory,config,blob})
 const workerRtt:number[]=[],workerOver:number[]=[]
 for(let k=1;k<=500;k++){const s=Bun.nanoseconds();const r=await ask({kind:'advance',target:t+k*0.02,mode:AdvanceMode.stop,observe:true});const rtt=(Bun.nanoseconds()-s)*1e-9;workerRtt.push(rtt);workerOver.push(rtt-(r.handlerS as number))}
 await ask({kind:'close'});worker.terminate()
 // A native abort in process ends the whole hosting Bun process.
 const probe=Bun.spawn([process.execPath,'-e',`const {dlopen,FFIType}=require('bun:ffi');const l=dlopen(${JSON.stringify(join(directory,`libleitbild_ld01_host_spike.${suffix}`))},{ld01_spike_abort:{args:[],returns:FFIType.void}});console.log('calling abort');l.symbols.ld01_spike_abort();console.log('survived')`],{stdout:'pipe',stderr:'pipe'})
 await probe.exited
 receipt.ffi={experimental_in_bun_1_4:'bun:ffi docs: experimental, known bugs, not for production',
  noop_ns_per_call:noop.map(ms=>ms*1e6/1_000_000),
  main_thread_50hz_stop_observe:{exchange_wall_us:us(ffiWall),parent_cpu_s_per_s:(ffiCpu.user+ffiCpu.system)*1e-6/10},
  worker_50hz_stop_observe:{round_trip_us:us(workerRtt),overhead_us:us(workerOver)},
  abort_in_process:{exitCode:probe.exitCode,signalCode:probe.signalCode,stdout:(await new Response(probe.stdout).text()).trim()}}
 log('ffi '+JSON.stringify(receipt.ffi))

 await Promise.all([host,fresh,replacement].map(h=>h.close()))
 receipt.wall_s=(Bun.nanoseconds()-started)*1e-9
 receipt.load_average_end=(await Bun.$`sysctl -n vm.loadavg`.nothrow().text()).trim()
 await writeFile(receiptPath,JSON.stringify(receipt,null,1))
 log('wrote '+receiptPath)
}

if(!Bun.isMainThread)serveWorker()
else if(import.meta.main){
 const [directory,receipt]=process.argv.slice(2)
 if(!directory||!receipt)throw Error('usage: bun scripts/ld01-host-spike.ts <host-release-dir> <receipt.json>')
 await main(directory,receipt)
}
