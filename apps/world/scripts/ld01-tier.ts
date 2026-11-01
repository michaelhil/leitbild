/** TEST-ONLY LD-01 test tiers on this Mac (lane OU-D; BACKLOG T1/T2, V3).
 * Nothing here is registered in a Pack, the Runtime Hub or the deployer.
 *
 * - T1, per commit (runs <= 2 quiet CPU-min): clippy -D warnings on T1's
 *   test crates; the operating crate's P5 guard (solver_prohibitions); the
 *   unit tests of the S3 case and Z6 harnesses, MR-1's matrix_rebuild guard,
 *   the regression crate (the pin lock among them) and S2's harness; the
 *   smoke (its own committed expectation);
 *   C2's ungated preview from the saved S3 state at spans 0 s and 2.5 s
 *   after zero (the trip's burst), each against the committed T1
 *   expectation: instructions retired within +-1 % and the trajectory digest
 *   bitwise. R4-COST-RESOLUTION applied to T1 (lead, 1 Nov: C2@0 failed
 *   +1.2..1.3 % under load with equal digests): a span whose first run is
 *   within 2 % of its pin, digest equal, runs twice more and its median of
 *   3 is judged against the +-1 % band; outside 2 % the one run decides.
 *   The digest stays decisive on every run.
 * - T2, the affected case (<= 10 quiet CPU-min): one case's ungated preview
 *   from the saved S3 state at its declared duration (or a shorter span),
 *   against its golden baseline when one is committed (same two checks).
 * - Ladder (R2's span differences, indicator 6): one case's previews at
 *   spans 0, step, 2 step, ... s; consecutive differences of instructions
 *   retired give the cost of each interval (ld01-indicators --ladder).
 * Builds are reported apart and never counted in a tier's budget.
 *
 * Every invocation writes a new write-once receipt directory: tuple.json
 * (app commit, tree state, this script's and its library's sha256, every
 * LD01_*, ELEC_* and CARGO_TARGET_DIR variable with the sha256 of each file
 * it names), one log and one time report per step, and tier.json (per step:
 * exit, instructions retired, quiet-equivalent CPU-s, thread CPU beside;
 * per pinned span: the pin, the measurement, the verdict).
 *
 * Usage (from apps/world, with the lane's environment, e.g.
 * `. $SP/env.sh <lane>; . <gate env>`):
 *   bun scripts/ld01-tier.ts t1 [--out <new dir>] [--record <new expectation file> --reason <text>] [--pins <file>]
 *   bun scripts/ld01-tier.ts t2 <C1|C2|C3|C4|C5> [span_s] [--out <new dir>] [--record <new baseline file> --reason <text> [--closed-step <receipt>]]
 *   bun scripts/ld01-tier.ts ladder <C1|C2|C3|C4|C5> <to_s> [step_s, default 0.5] [--out <new dir>]
 * The default directory is $LD01_RECEIPTS/tiers/<tier>-<commit>-<UTC stamp>.
 * --record writes the measured pins to a new file (never over one), only
 * from a clean tree, carrying the reason; a changed pin is committed with
 * the lead's reason (golden baselines: re-recorded once per gate). A T2
 * baseline recorded with --closed-step names the receipt of record and
 * refuses unless the span's digest equals that receipt's `run` digest; a
 * later T2 re-checks the receipt's sha256 (the record unchanged). --pins
 * judges against another pin file (a deliberate-failure test seeds one: the
 * tier must FAIL on it and exit 1). */
import {spawnSync} from 'node:child_process'
import {existsSync,readFileSync,statSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {QUIET_RATIO,digest,newReceiptDir,parseTimeL,quietCpuS,relativeDifference,sha256File,stamp,writeJsonOnce,type TimeReport} from './ld01-receipts'

const world=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const operating=join(world,'native/process-plant/operating')
const waterFfi=join(operating,'water-ffi')
const pinDir=join(waterFfi,'tests/ld01_regression')
const platform=`${process.platform==='darwin'?'macos':process.platform}-${process.arch==='arm64'?'aarch64':process.arch}`

/** The receipt sections a span's trajectory digest covers: the frame record
 * (PZR roof, SG pressures, rod travel at every 0.1 s frame), the solver's
 * segment and total counts, the instant classes, the protection log and the
 * event timeline. CPU fields are excluded by construction. */
export const TRAJECTORY_SECTIONS=['frames','segments','stock_totals','counts_by_class','protection_log','timeline'] as const
export const INSTRUCTION_TOLERANCE=0.01
export const T1_BUDGET_QUIET_S=120
export const T2_BUDGET_QUIET_S=600
export const T1_SPANS=[0,2.5] as const
/** R4-COST-RESOLUTION on T1 (lead, 1 Nov): within this band of the pin a
 * span is judged on the median of T1_REPEATS runs. */
export const RESOLUTION_BAND=0.02
export const T1_REPEATS=3

const REQUIRED=['LD01_OPERATING_WATER_LIB_DIR','LD01_OPERATING_SUNDIALS_PREFIX','LD01_OPERATING_HOT_SPINE_PACKET','LD01_WIKI_ROOT',
 'LD01_S3_STATE','LD01_S3_DECLARATION','LD01_S3_DECISION_LOG','ELEC_PACKET','CARGO_TARGET_DIR','LD01_RECEIPTS'] as const

type Step={name:string,cwd:string,args:string[],env?:Record<string,string>,budgeted:boolean}
type StepResult={name:string,command:string,cwd:string,env:Record<string,string>,exit:number|null,budgeted:boolean,
 time:TimeReport,quiet_cpu_s:number,thread_cpu_s:number,wall_s:number,log:string}
export type SpanPin={instructions:number,digest:string}
/** A golden baseline's closed step: the receipt of record whose `run`
 * section the span reproduces (V3: closed-step receipts become baselines). */
export type ClosedStep={receipt:string,receipt_sha256:string,digest:string}
export type Expectation={kind:string,platform:string,reason:string,recorded_from:string,app:string,
 environment:Record<string,string|null>,instruction_tolerance:number,spans:Record<string,SpanPin>,closed_step?:ClosedStep}

const cargo=(cwd:string,...args:string[]):Pick<Step,'cwd'|'args'>=>({cwd,args:['cargo','test','--release','--offline','--locked',...args]})
const water=(...a:string[])=>cargo(waterFfi,'--features','quadratures',...a)
/** T1's test crates: the case and Z6 harnesses, MR-1's guard, the regression
 * crate (smoke, settled pin, pin lock) and S2's harness of record. */
export const T1_CRATES=['s3_cases','s3_spectrum','matrix_rebuild','ld01_regression','s2_gates','s2_conservation'] as const
const tests=(crates:readonly string[])=>crates.flatMap(c=>['--test',c])

function git(...args:string[]){
 const r=spawnSync('git',['-C',world,...args],{encoding:'utf8'})
 if(r.status!==0)throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
 return r.stdout.trim()
}

/** The content identity of the run's tuple: each named file's sha256. */
function environment(){
 const vars:Record<string,{value:string,sha256:string|null,kind:string}>={}
 for(const [k,v] of Object.entries(process.env).sort(([a],[b])=>a<b?-1:1)){
  if(v===undefined||!(k.startsWith('LD01_')||k.startsWith('ELEC_')||k==='CARGO_TARGET_DIR'))continue
  const kind=existsSync(v)?(statSync(v).isDirectory()?'directory':'file'):'value'
  vars[k]={value:v,kind,sha256:kind==='file'?sha256File(v):null}
 }
 return vars
}

/** The pins' environment: what a span's trajectory depends on, by content.
 * The declaration and decision-log pages are not in it: they gain rows
 * that leave a case untouched, the harness checks the case block's own pin,
 * and a changed block value changes the digest. */
function pinEnvironment(env:ReturnType<typeof environment>){
 const file=(k:string)=>env[k]?.sha256??null
 return {packet_sha256:file('LD01_OPERATING_HOT_SPINE_PACKET'),state_sha256:file('LD01_S3_STATE'),elec_packet_sha256:file('ELEC_PACKET'),
  wiki_commit:env.LD01_WIKI_COMMIT?.value??null,
  water_lib_dir:env.LD01_OPERATING_WATER_LIB_DIR?.value??null,sundials_prefix:env.LD01_OPERATING_SUNDIALS_PREFIX?.value??null}
}

function run(out:string,step:Step):StepResult{
 const env={...process.env,...step.env,CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER:'/usr/bin/time -l'} as Record<string,string>
 const started=Date.now()
 const [cmd,...args]=step.args
 if(cmd===undefined)throw new Error(`${step.name}: no command`)
 const r=spawnSync(cmd,args,{cwd:step.cwd,env,encoding:'utf8',maxBuffer:1<<30})
 const wall=(Date.now()-started)/1000
 const log=join(out,`${step.name}.log`)
 writeFileSync(log,`${r.stdout??''}\n--- stderr ---\n${r.stderr??''}`,{flag:'wx'})
 const time=parseTimeL(r.stderr??'')
 const result:StepResult={name:step.name,command:step.args.join(' '),cwd:step.cwd,env:step.env??{},exit:r.status,budgeted:step.budgeted,time,
  quiet_cpu_s:quietCpuS(time.instructions),thread_cpu_s:time.userS+time.sysS,wall_s:wall,log}
 console.log(`${step.name}: exit ${r.status}, ${(time.instructions/1e9).toFixed(1)} G instructions = ${result.quiet_cpu_s.toFixed(1)} quiet CPU-s (thread ${result.thread_cpu_s.toFixed(1)} s, wall ${wall.toFixed(1)} s)`)
 if(r.status!==0)console.log((r.stdout??'').split('\n').filter(l=>/FAILED|panicked|differs|error/.test(l)).slice(0,12).join('\n'))
 return result
}

const spanKey=(c:string,s:number|null)=>`${c}@${s===null?'declared':s}`
function spanStep(out:string,c:string,span:number|null,repeat=1):Step{
 const file=repeat===1?spanKey(c,span):`${spanKey(c,span)}-r${repeat}`
 const env:Record<string,string>={LD01_S3_CASE:c,LD01_S3_PREVIEW:'1',LD01_S3_CASE_RECEIPT:join(out,`${file}.json`)}
 if(span!==null)env.LD01_S3_PREVIEW_SPAN_S=String(span)
 return {name:repeat===1?`span-${file}`:`repeat-${file}`,...water('--test','s3_cases','s3_case_run','--','--ignored','--exact','--nocapture'),env,budgeted:true}
}

/** A completed span step's measurement: instructions retired and the
 * trajectory digest of its receipt (null when the step failed). */
function measureSpan(r:StepResult):{measured:SpanPin,receipt:{verdict?:string}}|null{
 const path=r.env.LD01_S3_CASE_RECEIPT
 if(r.exit!==0||path===undefined||!existsSync(path))return null
 const receipt=JSON.parse(readFileSync(path,'utf8')) as {run:Record<string,unknown>,verdict?:string}
 return {measured:{instructions:r.time.instructions,digest:digest(receipt.run,TRAJECTORY_SECTIONS)},receipt}
}

/** The median of an odd number of values. */
export function median(xs:number[]){
 const s=[...xs].sort((a,b)=>a-b)
 return s[(s.length-1)/2] as number
}

/** A span's measurement against its pin. */
export function judgeSpan(pin:SpanPin|undefined,measured:SpanPin,tolerance=INSTRUCTION_TOLERANCE){
 if(!pin)return {verdict:'no pin',pin:null,measured}
 const d=relativeDifference(measured.instructions,pin.instructions)
 const instructionsOk=Math.abs(d)<=tolerance,digestOk=measured.digest===pin.digest
 return {verdict:instructionsOk&&digestOk?'pass':'fail',pin,measured,instructions_relative_difference:d,instructions_within_tolerance:instructionsOk,digest_equal:digestOk}
}

/** Environment mismatches between a pin file and this run (a pin judges
 * only the tuple it was recorded on). */
export function environmentMismatch(pinned:Record<string,string|null>,current:Record<string,string|null>){
 return Object.keys(pinned).filter(k=>pinned[k]!==current[k]).map(k=>({key:k,pinned:pinned[k],current:current[k]??null}))
}

function main(argv:string[]){
 const [tier,...rest]=argv
 const flag=(name:string)=>{const i=rest.indexOf(name);if(i<0)return undefined;const v=rest[i+1];rest.splice(i,2);if(v===undefined)throw new Error(`${name} needs a value`);return v}
 const outArg=flag('--out'),record=flag('--record'),reason=flag('--reason'),closedStepArg=flag('--closed-step'),pinsArg=flag('--pins')
 if(pinsArg&&record){console.error('ld01-tier: --pins judges against a given pin file; it does not record');process.exit(2)}
 if(closedStepArg&&(tier!=='t2'||!record)){console.error('ld01-tier: --closed-step names a T2 baseline\'s receipt of record (with --record)');process.exit(2)}
 if(tier!=='t1'&&tier!=='t2'&&tier!=='ladder'){console.error('usage: bun scripts/ld01-tier.ts t1|t2|ladder ... (see the header)');process.exit(2)}
 if(tier==='ladder'&&(record||closedStepArg)){console.error('ld01-tier ladder: no pins');process.exit(2)}
 const missing=REQUIRED.filter(k=>!process.env[k])
 if(missing.length){console.error(`ld01-tier: set ${missing.join(' ')} (e.g. '. $SP/env.sh <lane>; . <gate env>')`);process.exit(2)}
 if(record&&!reason){console.error('ld01-tier: --record needs --reason');process.exit(2)}
 const caseName=tier==='t1'?'C2':rest[0]
 if(tier!=='t1'&&!/^C[1-5]$/.test(caseName??'')){console.error(`ld01-tier ${tier}: name a case C1..C5`);process.exit(2)}
 const t2Span=tier==='t2'&&rest[1]!==undefined?Number(rest[1]):null
 const ladderTo=tier==='ladder'?Number(rest[1]):NaN,ladderStep=tier==='ladder'?Number(rest[2]??0.5):NaN
 if(tier==='ladder'&&!(ladderTo>0&&ladderStep>0&&ladderTo/ladderStep<=40)){console.error('ld01-tier ladder: <to_s> > 0, a step > 0, at most 40 spans');process.exit(2)}
 if(t2Span!==null&&!(t2Span>=0))throw new Error(`span ${rest[1]} is not a non-negative number`)
 const app=git('rev-parse','--short=9','HEAD')
 const dirty=git('status','--porcelain','--untracked-files=no','--','native/process-plant','scripts')
 if(record&&dirty){console.error('ld01-tier: --record refuses a dirty tree');process.exit(2)}
 const out=newReceiptDir(outArg??join(process.env.LD01_RECEIPTS??'',`tiers/${tier}-${app}-${stamp()}`))
 const env=environment()
 const pinEnv=pinEnvironment(env)
 const self=fileURLToPath(import.meta.url)
 writeJsonOnce(join(out,'tuple.json'),{kind:`ld01-${tier}-tuple`,app,app_full:git('rev-parse','HEAD'),dirty:dirty?dirty.split('\n'):false,
  script:self,script_sha256:sha256File(self),library_sha256:sha256File(join(dirname(self),'ld01-receipts.ts')),
  platform,quiet_ratio:QUIET_RATIO,environment:env,pin_environment:pinEnv,start:new Date().toISOString()})
 console.log(`ld01-tier ${tier} at ${app}${dirty?' (dirty: not a pin source)':''} -> ${out}`)

 const steps:Step[]=[]
 if(tier==='t1'){
  steps.push({name:'build-water',...water(...tests(T1_CRATES),'--no-run'),budgeted:false})
  steps.push({name:'clippy',cwd:waterFfi,args:['cargo','clippy','--release','--offline','--locked','--features','quadratures',...tests(T1_CRATES),'--','-D','warnings'],budgeted:false})
  steps.push({name:'build-guard',...cargo(operating,'--test','solver_prohibitions','--no-run'),budgeted:false})
  steps.push({name:'guard',...cargo(operating,'--test','solver_prohibitions'),budgeted:true})
  steps.push({name:'unit',...water(...tests(T1_CRATES)),budgeted:true})
  steps.push({name:'smoke',...water('--test','ld01_regression','--','--ignored','--exact','smoke','--test-threads=1','--nocapture'),budgeted:true})
  for(const s of T1_SPANS)steps.push(spanStep(out,'C2',s))
 }else if(tier==='ladder'){
  steps.push({name:'build-water',...water('--test','s3_cases','--no-run'),budgeted:false})
  for(let i=0;i*ladderStep<=ladderTo+1e-9;i++)steps.push(spanStep(out,caseName??'',Number((i*ladderStep).toFixed(6))))
 }else{
  steps.push({name:'build-water',...water('--test','s3_cases','--no-run'),budgeted:false})
  steps.push(spanStep(out,caseName??'',t2Span))
 }
 const results:StepResult[]=[]
 for(const step of steps){
  const r=run(out,step);results.push(r)
  if(r.exit!==0&&r.name.startsWith('build-'))break // a failed build stops the tier
 }

 const pinFile=pinsArg?resolve(pinsArg):tier==='t1'?join(pinDir,`tier1-${platform}.json`):join(pinDir,'golden',`${spanKey(caseName??'',t2Span)}-${platform}.json`)
 const expectation=existsSync(pinFile)?JSON.parse(readFileSync(pinFile,'utf8')) as Expectation:null
 const mismatch=expectation?environmentMismatch(expectation.environment,pinEnv):[]
 const closedStep=expectation?.closed_step
 const closedStepCheck=closedStep?{receipt:closedStep.receipt,unchanged:existsSync(closedStep.receipt)&&sha256File(closedStep.receipt)===closedStep.receipt_sha256}:null
 if(closedStepCheck&&!closedStepCheck.unchanged)mismatch.push({key:'closed_step.receipt_sha256',pinned:closedStep?.receipt_sha256??null,current:existsSync(closedStep?.receipt??'')?sha256File(closedStep?.receipt??''):null})
 const spans:Record<string,unknown>={},measuredPins:Record<string,SpanPin>={}
 for(const r of results.filter(x=>x.name.startsWith('span-'))){
  const key=r.name.slice(5),path=join(out,`${key}.json`)
  const first=measureSpan(r)
  if(first===null){spans[key]={verdict:'fail',reason:`the span did not complete (exit ${r.exit})`};continue}
  const {measured,receipt}=first
  measuredPins[key]=measured
  const pin=expectation?.spans[key]
  // R4-COST-RESOLUTION on T1: within 2 % of the pin, digest equal, the
  // median of 3 runs is judged; every repeat's digest must equal the pin.
  if(tier==='t1'&&!mismatch.length&&pin&&measured.digest===pin.digest&&Math.abs(relativeDifference(measured.instructions,pin.instructions))<=RESOLUTION_BAND){
   const span=r.env.LD01_S3_PREVIEW_SPAN_S===undefined?null:Number(r.env.LD01_S3_PREVIEW_SPAN_S)
   const runs:SpanPin[]=[measured]
   let failed:string|null=null
   for(let i=2;i<=T1_REPEATS&&failed===null;i++){
    const rr=run(out,spanStep(out,r.env.LD01_S3_CASE??'',span,i));results.push(rr)
    const m=measureSpan(rr)
    if(m===null)failed=`repeat ${i} did not complete (exit ${rr.exit})`
    else runs.push(m.measured)
   }
   if(failed!==null){spans[key]={verdict:'fail',reason:failed,receipt:path,receipt_verdict:receipt.verdict??null};continue}
   const judged=judgeSpan(pin,{instructions:median(runs.map(x=>x.instructions)),digest:runs.every(x=>x.digest===pin.digest)?pin.digest:'a repeat differs'})
   spans[key]={...judged,resolution:{rule:'R4-COST-RESOLUTION (T1, lead 1 Nov)',band:RESOLUTION_BAND,runs:runs.map(x=>({instructions:x.instructions,digest:x.digest,relative_difference:relativeDifference(x.instructions,pin.instructions)}))},
    receipt:path,receipt_verdict:receipt.verdict??null}
   continue
  }
  spans[key]={...(mismatch.length?{verdict:'not judged',reason:'the pin was recorded on another tuple',mismatch}:judgeSpan(pin,measured)),
   receipt:path,receipt_verdict:receipt.verdict??null}
 }
 const budgetedQuiet=results.filter(r=>r.budgeted).reduce((s,r)=>s+r.quiet_cpu_s,0)
 const budget=tier==='t1'?T1_BUDGET_QUIET_S:T2_BUDGET_QUIET_S // a ladder is measured against T2's
 const failedSteps=results.filter(r=>r.exit!==0).map(r=>r.name)
 const spanVerdicts=Object.values(spans).map(s=>(s as {verdict:string}).verdict)
 const verdict=failedSteps.length||spanVerdicts.includes('fail')?'FAIL':tier==='ladder'?'MEASURED':spanVerdicts.every(v=>v==='pass')?'PASS':'INCOMPLETE'
 const summary={kind:`ld01-${tier}`,app,dirty:Boolean(dirty),verdict,failed_steps:failedSteps,spans,closed_step:closedStepCheck,pin_file:existsSync(pinFile)?pinFile:null,
  pin_file_sha256:existsSync(pinFile)?sha256File(pinFile):null,
  budget:{quiet_cpu_s:budgetedQuiet,limit_quiet_cpu_s:budget,within:budgetedQuiet<=budget,instructions:results.filter(r=>r.budgeted).reduce((s,r)=>s+r.time.instructions,0)},
  steps:results,end:new Date().toISOString()}
 writeJsonOnce(join(out,`${tier}.json`),summary)
 console.log(`ld01-tier ${tier}: ${verdict}; runs ${budgetedQuiet.toFixed(1)} quiet CPU-s of ${budget}${budgetedQuiet>budget?' (OVER BUDGET)':''}; spans ${JSON.stringify(Object.fromEntries(Object.entries(spans).map(([k,v])=>[k,(v as {verdict:string}).verdict])))}`)
 if(record){
  if(failedSteps.length){console.error('ld01-tier: --record refuses a run with a failed step');process.exit(1)}
  const pins:Expectation={kind:tier==='t1'?'ld01-tier1-expectation':'ld01-golden-baseline',platform,reason:reason??'',recorded_from:out,app,
   environment:pinEnv,instruction_tolerance:INSTRUCTION_TOLERANCE,spans:measuredPins}
  if(closedStepArg){
   const of=JSON.parse(readFileSync(closedStepArg,'utf8')) as {run:Record<string,unknown>}
   const closed={receipt:resolve(closedStepArg),receipt_sha256:sha256File(closedStepArg),digest:digest(of.run,TRAJECTORY_SECTIONS)}
   const measured=Object.values(measuredPins)[0]
   if(measured?.digest!==closed.digest){console.error(`ld01-tier: the span does not reproduce the closed step (${measured?.digest} vs ${closed.digest}): no baseline`);process.exit(1)}
   pins.closed_step=closed
  }
  writeJsonOnce(record,pins)
  console.log(`ld01-tier: pins written to ${record} (commit it with the reason)`)
 }
 process.exit(verdict==='PASS'?0:1)
}

if(import.meta.main)main(process.argv.slice(2))
