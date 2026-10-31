/** TEST-ONLY LD-01 cost judge `ld01-cost` (plan r4, lane PERF, E-PROF): the
 * one measure of a unit's cost per simulated second. Nothing here is
 * registered in a Pack, the Runtime Hub or the deployer.
 *
 * Input: S3 case receipts whose drive recorded the process's instructions
 * retired at every 0.1 s frame (`run.ou_frame_instructions`,
 * LD01_OU_FRAME_COST=1; for a gated receipt the ungated cost drive's
 * `families.G_cost.ou_cost_drive_frames`), and optionally the cost profile
 * (`run.perf_profile`, LD01_PERF_PROFILE=1).
 *
 * Rule (fixed; plan r4 "Cost budget per unit"):
 * - Rate of a frame interval: r = (dI / quietRatio) / dt, M2 quiet CPU-s per
 *   simulated second; quietRatio 14.32e9 instructions per quiet CPU-s.
 * - The event is the case's `timeline.zero_s` (else its first R instant,
 *   else the first frame). Times are reported after it.
 * - worst_0_5_s: the highest mean rate over 5 consecutive frame intervals
 *   anywhere in the trace (also worst frame and worst 2.5 s).
 * - steady: the mean rate over the last 10 s of the trace; pre_event: the
 *   mean before the event when at least 2 s precede it.
 * - restarts_per_s_after_10_s: R instants at or after event + 10 s per
 *   second of trace after event + 10 s.
 * - seat_window: from the event to the first frame at or after the last
 *   rod seat (`timeline.last_seat_s`, after the event), its mean rate (and
 *   breakdown when profiled): each lane's seat baseline.
 * - peak_lag_s: one unit on one M2 core, lag = max(0, lag + (r - 1) dt).
 * - budget: worst_0_5_s <= 0.7 and steady <= 0.1 (B-dedicated, must);
 *   worst_0_5_s <= 0.25 and steady <= 0.05 (B-prod, aim).
 * - breakdown (profiled receipts only) over the worst 0.5 s window, the
 *   seat window, the first 10 s after the event and the steady span: each profile path's
 *   exclusive instructions grouped by kind (KLU factor, KLU solve, nuclear
 *   rows, owner rows, network residual, Jacobian assembly, roots, IDA
 *   internals, the restart's own consistent start (its Jacobian, residual
 *   and LU), event handling, observers, other = frame instructions not in
 *   any scope) and by phase (event handling, the step's place in its
 *   segment, observers, other), with the solver counts and the profile's
 *   own overhead (counter reads x instructions per read). A profiled run's
 *   frame instructions include that overhead; cost verdicts read the
 *   unprofiled run of the same trajectory.
 *
 * Usage: bun scripts/ld01-cost.ts [--quiet-ratio r] [--table] <receipt.json>...
 * Prints one JSON object per receipt (with --table, a short text table). */
import {readFileSync} from 'node:fs'
import {basename} from 'node:path'

export const QUIET_RATIO=14.32e9
export const BUDGET={dedicated:{worst:0.7,steady:0.1},prod:{worst:0.25,steady:0.05}} as const

export type Frames=[number,number][]
type ProfileFrame=[number,number,[number,number][]]
export type Profile={paths:string[],read_instructions:number,frames:ProfileFrame[]}
type Window={rate:number,from_after_event_s:number|null}

/** The frame trace, event time, R instants and profile of a receipt. */
export function traceOf(receipt:any){
 const run=receipt.run??receipt
 const frames:Frames|undefined=receipt.families?.G_cost?.ou_cost_drive_frames??run.ou_frame_instructions
 if(!frames||frames.length<2)throw new Error('the receipt has no frame instructions (LD01_OU_FRAME_COST=1)')
 const restarts:number[]=(run.instants??[]).filter((e:any)=>e.class==='R').map((e:any)=>e.t_s)
 const zero=receipt.timeline?.zero_s??run.timeline?.zero_s
 const event:number=typeof zero==='number'?zero:(restarts[0]??frames[0][0])
 const seat=receipt.timeline?.last_seat_s??run.timeline?.last_seat_s
 const lastSeat:number|null=typeof seat==='number'?seat:null
 const profile:Profile|undefined=run.perf_profile??undefined
 // The profile is the run drive's: its totals are read on the run's frames.
 const runFrames:Frames|undefined=run.ou_frame_instructions??undefined
 return {frames,runFrames,event,restarts,lastSeat,profile,case:receipt.case??run.case??null}
}

function rates(frames:Frames,ratio:number){
 const out:number[]=[]
 for(let k=1;k<frames.length;k++){
  const dt=frames[k][0]-frames[k-1][0]
  if(!(dt>0))throw new Error(`frames out of order at ${frames[k][0]} s`)
  out.push((frames[k][1]-frames[k-1][1])/ratio/dt)
 }
 return out
}
function meanRate(frames:Frames,a:number,b:number,ratio:number){
 return (frames[b][1]-frames[a][1])/ratio/(frames[b][0]-frames[a][0])
}
/** Highest mean rate over `n` consecutive intervals: [rate, first frame]. */
function worst(frames:Frames,n:number,ratio:number):[number,number]{
 let best=-Infinity,at=0
 for(let k=0;k+n<frames.length;k++){
  const r=meanRate(frames,k,k+n,ratio)
  if(r>best){best=r;at=k}
 }
 return [best,at]
}
const firstAtOrAfter=(frames:Frames,t:number)=>{const k=frames.findIndex(f=>f[0]>=t-1e-9);return k<0?frames.length-1:k}

/** Kind of one profile path (exclusive instructions). */
export function kindOf(path:string):string|null{
 if(path.startsWith('pieces>'))return null
 const parts=path.split('>'),leaf=parts[parts.length-1]
 if(leaf==='klu-setup')return 'KLU factor'
 if(leaf==='klu-solve')return 'KLU solve'
 if(leaf==='nuclear')return 'nuclear rows'
 if(leaf==='solids'||leaf==='rods'||leaf==='secondary')return 'owner rows'
 if(leaf==='lu-analyze')return 'restart start: LU analysis'
 if(leaf==='lu-factor'||leaf==='lu-refactor')return 'restart start: LU factor'
 if(leaf==='lu-solve')return 'restart start: LU solve'
 if(leaf==='start-jacobian')return 'restart start: Jacobian assembly'
 if(leaf==='start-residual')return 'restart start: network residual'
 if(leaf==='residual')return 'network residual'
 if(leaf==='jacobian')return 'Jacobian assembly'
 if(leaf==='roots')return 'roots'
 if(leaf==='quadrature')return 'quadratures'
 if(leaf.startsWith('step[')||leaf==='advance'||leaf==='ic'||leaf==='reinit')return 'IDA internals'
 if(leaf==='apply')return 'event handling'
 if(leaf==='observe'||leaf==='step-state'||leaf==='gate')return 'observers'
 return 'other'
}
/** Phase of one profile path: its outermost scope. */
export function phaseOf(path:string):string|null{
 if(path.startsWith('pieces>'))return null
 const root=path.split('>')[0]
 if(root==='apply')return 'event handling (incl. reinit, IC)'
 if(root.startsWith('step['))return `steps ${root.slice(4)} after segment start`
 if(root==='observe'||root==='step-state'||root==='gate')return 'observers'
 return `other: ${root}`
}

type Split={total_g:number,rate:number,by_kind:Record<string,number>,by_phase:Record<string,number>,
 jacobian_pieces_g:Record<string,number>,counts:Record<string,number>,overhead_share:number}

/** The profile's breakdown between frame times `ta` and `tb`. */
export function breakdown(profile:Profile,frames:Frames,ta:number,tb:number,ratio:number):Split{
 const at=(t:number)=>{const k=profile.frames.findIndex(f=>Math.abs(f[0]-t)<1e-9);if(k<0)throw new Error(`no profile frame at ${t} s`);return profile.frames[k]}
 const fa=at(ta),fb=at(tb)
 const ia=frames.find(f=>Math.abs(f[0]-ta)<1e-9)![1],ib=frames.find(f=>Math.abs(f[0]-tb)<1e-9)![1]
 const total=ib-ia,dt=tb-ta
 const byKind:Record<string,number>={},byPhase:Record<string,number>={},pieces:Record<string,number>={}
 const counts:Record<string,number>={steps:0,residuals:0,jacobians:0,klu_setups:0,klu_solves:0,restarts:0,ic:0}
 let scoped=0
 profile.paths.forEach((p,k)=>{
  const [ca,xa]=fa[2][k]??[0,0],[cb,xb]=fb[2][k]??[0,0]
  const x=xb-xa,c=cb-ca
  if(!x&&!c)return
  const leaf=p.split('>').pop()!
  if(p.startsWith('pieces>')){pieces[p.slice(7)]=(pieces[p.slice(7)]??0)+x/1e9;return}
  scoped+=x
  const kd=kindOf(p)!,ph=phaseOf(p)!
  byKind[kd]=(byKind[kd]??0)+x;byPhase[ph]=(byPhase[ph]??0)+x
  if(leaf.startsWith('step['))counts.steps+=c
  if(leaf==='residual')counts.residuals+=c
  if(leaf==='jacobian')counts.jacobians+=c
  if(leaf==='klu-setup')counts.klu_setups+=c
  if(leaf==='klu-solve')counts.klu_solves+=c
  if(leaf==='reinit')counts.restarts+=c
  if(leaf==='ic')counts.ic+=c
 })
 const other=total-scoped
 byKind['other (unscoped)']=other;byPhase['other (unscoped)']=other
 const share=(o:Record<string,number>)=>Object.fromEntries(Object.entries(o).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,Math.round(1000*v/total)/1000]))
 return {total_g:total/1e9,rate:total/ratio/dt,by_kind:share(byKind),by_phase:share(byPhase),
  jacobian_pieces_g:Object.fromEntries(Object.entries(pieces).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,Math.round(1000*v)/1000])),
  counts,overhead_share:(fb[1]-fa[1])*profile.read_instructions/total}
}

/** The judge's result for one receipt. */
export function judge(receipt:any,ratio=QUIET_RATIO){
 const {frames,runFrames,event,restarts,lastSeat,profile,case:c}=traceOf(receipt)
 const r=rates(frames,ratio)
 const t0=frames[0][0],tEnd=frames[frames.length-1][0]
 const win=(n:number):Window=>{const [rate,k]=worst(frames,n,ratio);return {rate,from_after_event_s:frames[k][0]-event}}
 const w5=win(5)
 const kSteady=firstAtOrAfter(frames,tEnd-10)
 const steady=meanRate(frames,kSteady,frames.length-1,ratio)
 const kEvent=firstAtOrAfter(frames,event)
 const preEvent=event-t0>=2?meanRate(frames,0,kEvent,ratio):null
 const after10=event+10
 const late=restarts.filter(t=>t>=after10-1e-9).length
 const restartsPerS=tEnd>after10?late/(tEnd-after10):null
 let lag=0,peak=0,peakAt:number|null=null
 for(let k=1;k<frames.length;k++){lag=Math.max(0,lag+(r[k-1]-1)*(frames[k][0]-frames[k-1][0]));if(lag>peak){peak=lag;peakAt=frames[k][0]-event}}
 const out:any={case:c,quiet_ratio:ratio,event_s:event,span_after_event_s:tEnd-event,
  worst_0_5_s:w5,worst_frame:win(1),worst_2_5_s:win(5*5),steady_last_10_s:steady,pre_event:preEvent,
  seat_window:lastSeat===null?null:(()=>{const a=firstAtOrAfter(frames,event),b=Math.max(a+1,firstAtOrAfter(frames,event+lastSeat));return {last_seat_after_event_s:lastSeat,to_after_event_s:frames[b][0]-event,rate:meanRate(frames,a,b,ratio)}})(),
  average:meanRate(frames,0,frames.length-1,ratio),restarts:restarts.length,
  restarts_per_s_after_10_s:restartsPerS,peak_lag_s:peak,peak_lag_after_event_s:peakAt,
  budget:{dedicated:w5.rate<=BUDGET.dedicated.worst&&steady<=BUDGET.dedicated.steady,
   prod:w5.rate<=BUDGET.prod.worst&&steady<=BUDGET.prod.steady},
  profiled:!!profile}
 if(profile){
  if(!runFrames)throw new Error('a profile without the run drive frames')
  const [,k5]=worst(runFrames,5,ratio)
  const k10=firstAtOrAfter(runFrames,event+10),ke=firstAtOrAfter(runFrames,event)
  const ks=firstAtOrAfter(runFrames,runFrames[runFrames.length-1][0]-10)
  const tf=(k:number)=>runFrames[k][0]
  out.breakdown={worst_0_5_s:breakdown(profile,runFrames,tf(k5),tf(k5+5),ratio),
   seat_window:lastSeat===null?null:breakdown(profile,runFrames,tf(ke),tf(Math.max(ke+1,firstAtOrAfter(runFrames,event+lastSeat))),ratio),
   first_10_s:ke<k10?breakdown(profile,runFrames,tf(ke),tf(k10),ratio):null,
   steady_last_10_s:breakdown(profile,runFrames,tf(ks),tf(runFrames.length-1),ratio)}
 }
 return out
}

function table(name:string,j:any){
 const f=(x:number|null)=>x===null?'-':x.toFixed(3)
 const lines=[`${name} ${j.case??''}: worst 0.5 s ${f(j.worst_0_5_s.rate)} at +${f(j.worst_0_5_s.from_after_event_s)} s; frame ${f(j.worst_frame.rate)}; 2.5 s ${f(j.worst_2_5_s.rate)}; steady ${f(j.steady_last_10_s)}; seats to +${f(j.seat_window?.to_after_event_s??null)} s ${f(j.seat_window?.rate??null)}; pre ${f(j.pre_event)}; restarts ${j.restarts} (${f(j.restarts_per_s_after_10_s)}/s after +10 s); peak lag ${f(j.peak_lag_s)} s; B-ded ${j.budget.dedicated?'pass':'FAIL'}, B-prod ${j.budget.prod?'pass':'FAIL'}`]
 if(j.breakdown)for(const [w,b] of Object.entries<any>(j.breakdown)){
  if(!b)continue
  const top=(o:Record<string,number>)=>Object.entries(o).filter(([,v])=>Math.abs(v)>=0.01).map(([k,v])=>`${k} ${(100*v).toFixed(0)}%`).join(', ')
  lines.push(`  ${w} (${f(b.rate)}): ${top(b.by_kind)}`,`    phases: ${top(b.by_phase)}`,
   `    counts: ${Object.entries(b.counts).map(([k,v])=>`${k} ${v}`).join(', ')}; overhead ${(100*b.overhead_share).toFixed(1)}%`)
 }
 return lines.join('\n')
}

if(import.meta.main){
 const args=process.argv.slice(2)
 let ratio=QUIET_RATIO,asTable=false
 const i=args.indexOf('--quiet-ratio')
 if(i>=0){ratio=Number(args[i+1]);args.splice(i,2)}
 const t=args.indexOf('--table')
 if(t>=0){asTable=true;args.splice(t,1)}
 if(!args.length||!(ratio>0)){console.error('usage: bun scripts/ld01-cost.ts [--quiet-ratio r] [--table] <receipt.json>...');process.exit(2)}
 for(const file of args){
  const j=judge(JSON.parse(readFileSync(file,'utf8')),ratio)
  console.log(asTable?table(basename(file),j):JSON.stringify({receipt:basename(file),...j}))
 }
}
