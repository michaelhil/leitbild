/** Inspection of the frozen native cold-motion experiment. Numerical policies
 * remain native-owned; this boundary prevents incomplete or inflated PASSes. */
import {createHash} from 'node:crypto'
import {isAbsolute,relative,resolve} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {z} from 'zod'

const finite=z.number().finite(),nonnegative=finite.nonnegative(),integer=z.number().int().nonnegative()
const ratio=nonnegative.max(1)
export type MotionCoolingExpected={unknowns:number,waterOwners:number,clusters:number,commonTimes:readonly number[]}
export type MotionCoolingArtifact={path:string,sha256:string}
const factorDiagnostic=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('block-factor-start'),block:z.string().min(1),factor:z.string().min(1),
  rows:integer.positive(),nonzeros:integer,attempt:integer.positive()}).strict(),
 z.object({kind:z.literal('block-factor-complete'),block:z.string().min(1),status:z.number().int(),seconds:nonnegative}).strict()
])
const sundialsLog=z.object({kind:z.literal('sundials-log'),level:z.enum(['ERROR','WARNING','INFO','DEBUG']),
 rank:z.number().int().refine(Number.isSafeInteger),scope:z.string().min(1),label:z.string().min(1),
 message:z.string().min(1),raw:z.string().min(1)}).strict()
/** Existing block factors emit NDJSON progress. SUNDIALS' native logger uses
 * [LEVEL][rank N][scope][label] message; libc may flush it after Rust's report.
 * Preserve those logs regardless of order, but never turn ERROR+PASS, unknown
 * text or post-report factor work into a successful terminal envelope. */
export function parseMotionCoolingStdout(stdout:string){
 const lines=stdout.trim().split(/\r?\n/),
  diagnostics:Array<z.infer<typeof factorDiagnostic>|z.infer<typeof sundialsLog>>=[]
 let result:unknown=null
 for(const line of lines){
  const log=/^\[(ERROR|WARNING|INFO|DEBUG)\]\[rank (-?\d+)\]\[([^\]\r\n]+)\]\[([^\]\r\n]+)\] (.+)$/.exec(line)
  if(log){
   diagnostics.push(sundialsLog.parse({kind:'sundials-log',level:log[1],rank:Number(log[2]),
    scope:log[3],label:log[4],message:log[5],raw:line}))
   continue
  }
  const record=JSON.parse(line) as unknown
  if(!record||typeof record!=='object'||Array.isArray(record))throw Error('Malformed motion native output record')
  if('kind' in record){
   if(result!==null)throw Error('Native diagnostics follow the final motion report')
   diagnostics.push(factorDiagnostic.parse(record))
  }else{
   if(result!==null)throw Error('Multiple motion native reports')
   result=z.union([
    z.object({status:z.literal('PASS'),trajectoryAdmitted:z.literal(true)}).passthrough(),
    z.object({status:z.literal('FAIL'),trajectoryAdmitted:z.literal(false),error:z.string().min(1)}).passthrough()
   ]).parse(record)
  }
 }
 if(result===null)throw Error('Missing terminal motion native report')
 if((result as {status:string}).status==='PASS'&&diagnostics.some(d=>d.kind==='sundials-log'&&d.level==='ERROR'))
  throw Error('SUNDIALS error log cannot coexist with motion PASS')
 return {result,diagnostics}
}
function checkExpected(expected:MotionCoolingExpected){
 for(const key of ['unknowns','waterOwners','clusters'] as const)
  if(!Number.isSafeInteger(expected[key])||expected[key]<=0)throw Error('Invalid expected motion '+key)
 if(expected.unknowns<=8*expected.clusters+1||expected.commonTimes.length<2||expected.commonTimes[0]!==0
  ||expected.commonTimes.at(-1)!==60.5||expected.commonTimes.some((t,i)=>!Number.isFinite(t)||(i>0&&t<=expected.commonTimes[i-1]!)))
  throw Error('Invalid expected cold motion shape/schedule')
}
const initialization=z.object({iterations:integer.positive(),chartIterations:integer.positive(),
 hydraulicRateIterations:integer.positive(),lastAppliedChartCorrectionL2:nonnegative,
 lastWeightedCorrectionScope:z.literal('remaining-hydraulic-state-and-all-rates'),seconds:nonnegative,
 lastWeightedCorrectionL2:nonnegative,maxForwardRateResidualMixedUnits:nonnegative}).passthrough()
const discrepancy=z.object({normal:finite,tighter:finite,bound:nonnegative,ratio}).passthrough()
const sourceComparison=z.object({comparisonScope:z.literal('one-common-time;not-full-pair'),
 accuracyPolicy:z.literal('source-consequences-1'),time:finite.positive(),
 local:discrepancy.extend({time:finite.positive(),source:z.string().min(1),index:integer,family:z.string().min(1),absoluteDifference:nonnegative,atol:nonnegative}),
 SUMABSFamilyPairRatio:ratio,observablePairRatio:ratio,comparedFamilyOutputs:integer,negligibleFamilyOutputs:integer,
 NCOperatorPairRatio:ratio,rawAtomCountDiagnostic:z.object({localPairRatio:nonnegative,SUMABSFamilyPairRatio:nonnegative,admission:z.literal(false)})}).passthrough()
const coolingComparison=z.object({policy:z.literal('cold-source-nuclear-heat'),provisional:z.literal(true),fullPairQualified:z.literal(false),
 source:sourceComparison,thermalTemperatureRatio:ratio,thermalEnergyRatio:ratio,thermalSUMABSRatio:ratio,
 networkTemperatureRatio:ratio,networkPressureRatio:ratio,secondaryMassRatio:ratio,SGHeatRatio:ratio,
 prhrPairRatio:ratio,carrierConsequenceRatio:ratio,depositionLocalRatio:ratio,depositionSUMABSRatio:ratio,
 barrelPairRatio:ratio,barrelPowerPairRatio:ratio,capturePowerLocalRatio:ratio,capturePowerSUMABSRatio:ratio,
 capturePaidEnergyRatio:ratio,mobileCapturePowerLocalRatio:ratio,mobileCapturePowerSUMABSRatio:ratio,
 mobileCapturePaidEnergyRatio:ratio,pressurePairRatio:ratio,pressureMaterialPairRatio:ratio,
 worstCooling:discrepancy.extend({family:z.string().min(1),row:integer,difference:nonnegative}).nullable()}).passthrough()
const event=z.union([
 z.object({time:finite.positive(),velocityEvents:integer,contactEvents:integer,separationEvents:integer,
  realImpactHeatJ:nonnegative,signedRootAdjustmentJ:finite}).passthrough(),
 z.object({time:finite.positive(),commandOrSupport:z.literal(true),requestedRate:finite}).passthrough()
])
const support=z.object({A:z.object({timeS:nonnegative,energyJ:nonnegative,sourceJ:nonnegative,deliveredJ:nonnegative,
 prhrDeliveredJ:nonnegative,otherDeliveredJ:nonnegative,lossJ:nonnegative,thermalReceivedJ:nonnegative,
 outputClosed:z.boolean(),cause:z.string().nullable(),chargerAvailable:z.boolean(),batteryAvailable:z.boolean(),outputHealthy:z.boolean(),
 opening:finite,springEnergyJ:nonnegative,holding:z.boolean(),closing:z.boolean(),nextEventS:finite.nullable(),eventCursor:integer}).passthrough(),
 B:z.object({energyJ:nonnegative,sourceJ:nonnegative,deliveredJ:nonnegative,lossJ:nonnegative,closed:z.boolean()}).passthrough(),
 bankHoldingJ:nonnegative,bankMotiveJ:nonnegative,nonBankAExportJ:finite,nonBankBExportJ:nonnegative,
 scope:z.literal('one-A-owner-including-PRHR;one-B-owner;A-losses-to-ROOM.A;B-losses-exported-to-omitted-ROOM.B')}).passthrough()
const costs=z.object({residuals:integer,bases:integer,actions:integer,recoverable:integer,
 residualSeconds:nonnegative,baseSeconds:nonnegative,actionSeconds:nonnegative,PSeconds:nonnegative,
 convergence:z.object({}).passthrough(),P:z.object({}).passthrough()}).passthrough()
const motionComparison=discrepancy.extend({time:nonnegative,suffixRow:integer,difference:nonnegative})
function finiteTree(value:unknown):void{
 if(typeof value==='number'&&!Number.isFinite(value))throw Error('Nonfinite retained motion report number')
 if(Array.isArray(value)){for(const item of value)finiteTree(item)}
 else if(value&&typeof value==='object'){for(const item of Object.values(value))finiteTree(item)}
}
export function parseMotionCoolingResult(raw:unknown,expected:MotionCoolingExpected){
 checkExpected(expected);finiteTree(raw)
 const suffix=8*expected.clusters+1,arm=z.object({passed:z.literal(true),lastAdmittedTime:z.literal(60.5),
  solverReturnedTime:z.literal(60.5),reason:z.null(),seconds:nonnegative,steps:integer.positive(),initialization,
  eventICCalls:integer,eventICSeconds:nonnegative,maxMechanicalDefectJ:nonnegative,maxThermalWorkDefectJ:nonnegative,
  finalMotion:z.array(finite).length(suffix),events:z.array(event).min(1),comparisons:z.array(coolingComparison),
  eventSnapshots:z.array(z.object({time:finite.positive().max(60.5),index:integer})),
  motionComparisons:z.array(motionComparison),costs,support}).passthrough()
 const result=z.object({status:z.literal('PASS'),scope:z.literal('cold-all52-accepted-motion-full98-SOURCE-water-thermal-single-clock'),
  trajectoryAdmitted:z.literal(true),liveModelInstalled:z.literal(false),unknowns:z.literal(expected.unknowns),
  waterOwners:z.literal(expected.waterOwners),clusters:z.literal(expected.clusters),elapsedS:nonnegative,normal:arm,tighter:arm}).passthrough().parse(raw)
 const positiveTimes=expected.commonTimes.filter(t=>t>0)
 for(const [name,a]of [['normal',result.normal],['tighter',result.tighter]] as const){
  if(a.initialization.chartIterations+a.initialization.hydraulicRateIterations!==a.initialization.iterations)
   throw Error('Motion initialization phase counts differ from total')
  if(a.support.A.timeS!==a.lastAdmittedTime)throw Error('Motion support and admitted state times differ')
  if(a.events.some((e,i)=>e.time>60.5||(i>0&&e.time<a.events[i-1]!.time)))throw Error('Motion event order/horizon differs')
  if(a.eventSnapshots.some((s,i)=>s.index!==i||(i>0&&s.time<a.eventSnapshots[i-1]!.time))
   ||a.events.some(e=>!a.eventSnapshots.some(s=>s.time===e.time))||a.eventSnapshots.some(s=>!a.events.some(e=>e.time===s.time)))
   throw Error('Missing or reordered committed event snapshots')
  const times=name==='normal'?[]:positiveTimes
  if(a.comparisons.length!==times.length||a.comparisons.some((c,i)=>c.source.time!==times[i]||c.source.local.time!==times[i]))
   throw Error('Missing or reordered inherited common-time SOURCE/cooling comparisons')
  const motionTimes=name==='normal'?[]:expected.commonTimes
  if(a.motionComparisons.length!==motionTimes.length||a.motionComparisons.some((c,i)=>c.time!==motionTimes[i]||c.suffixRow>=suffix))
   throw Error('Missing or reordered local mechanical comparison locators')
  for(const c of a.motionComparisons){
   const field=c.suffixRow%8,bound=c.suffixRow===suffix-1||field>=5?1e-5:1e-7
   if(c.bound!==bound||c.difference!==Math.abs(c.normal-c.tighter)||c.ratio!==c.difference/c.bound)
    throw Error('Mechanical comparison differs from the inherited absolute local policy')
  }
 }
 return result
}

/** Binary format is one little-endian time, then every physical state and rate.
 * No charts, samples, summaries or omitted algebraic coordinates are accepted. */
export function inspectMotionCoolingState(bytes:Uint8Array,unknowns:number,expectedTime:number){
 if(!Number.isSafeInteger(unknowns)||unknowns<=0||!Number.isFinite(expectedTime)
  ||bytes.byteLength!==8*(1+2*unknowns))throw Error('Wrong retained full motion state/rate byte length')
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
 if(view.getFloat64(0,true)!==expectedTime)throw Error('Retained motion state time differs')
 for(let row=1;row<1+2*unknowns;row++)if(!Number.isFinite(view.getFloat64(8*row,true)))
  throw Error('Nonfinite retained full motion state/rate coordinate')
 return {time:expectedTime,unknowns,bytes:bytes.byteLength}
}
function snapshotWords(bytes:Uint8Array){
 const text=new TextDecoder().decode(bytes).trim(),words=text?text.split(/\s+/).map(Number):[]
 if(!words.length||words.some(v=>!Number.isFinite(v)))throw Error('Malformed finite support snapshot words')
 return words
}
/** The native version-1 continuation frame embeds all A words and the complete
 * 36-word B/support continuation, not just current energy/export summaries.
 * Native restore remains responsible for physical config/history admission. */
export function inspectMotionCoolingSupport(bytes:Uint8Array,expectedTime:number){
 const words=snapshotWords(bytes),n=words[2]!
 if(words[0]!==1||words[1]!==expectedTime||!Number.isSafeInteger(n)||n<34||words.length!==n+39
  ||words[3+n-34]!==expectedTime)
  throw Error('Incomplete, mismatched or wrong-time full A/B support continuation')
 const b=words.slice(n+3)
 if([9,14,15,16,24].some(i=>b[i]!==0&&b[i]!==1)||!Number.isInteger(b[10])||b[10]!<0||b[10]!>3
  ||b[7]!<0||b[7]!>expectedTime||b[32]!<0||b[32]!>expectedTime||b[17]!==b[28]!+b[27]!)
  throw Error('Malformed retained B/support clock, branch or duty')
 return {time:expectedTime,aWords:n,bWords:b.length,
  input:{requestedRate:b[29]!,motivePower:b[27]!,holdingPower:b[26]!}}
}
export function inspectMotionCoolingMode(bytes:Uint8Array,clusters:number){
 const words=new TextDecoder().decode(bytes).trim().split(/\s+/),count=Number(words[1]),
  requestedRate=Number(words[2]),motivePower=Number(words[3]),holdingPower=Number(words[4])
 if(words[0]!=='SOURCE_MOTION_MODE'||count!==clusters||words.length!==5+5*clusters
  ||![requestedRate,motivePower,holdingPower].every(Number.isFinite)||holdingPower<=0||motivePower<0
  ||(requestedRate===0?motivePower!==0:motivePower===0))throw Error('Incomplete ordinary mechanical mode snapshot')
 const regulators=new Set(['approach-positive','approach-negative','track','hold-positive','hold-negative','hold-rest','open'])
 const branches=Array.from({length:clusters},(_,i)=>{
  const [regulator,joint,...geometry]=words.slice(5+5*i,10+5*i)
  if(!regulators.has(regulator!)||!['contact','separated'].includes(joint!)||geometry.some(v=>v!=='0'&&v!=='1'))
   throw Error('Invalid mechanical mode branch or geometry-side snapshot')
  return {regulator:regulator!,joint:joint!,bodyRight:geometry[0]==='1',stemRight:geometry[1]==='1',seated:geometry[2]==='1'}
 })
 return {input:{requestedRate,motivePower,holdingPower},branches}
}
export async function validateMotionCoolingArtifacts(raw:unknown,directory:string,expected:MotionCoolingExpected,
 result:ReturnType<typeof parseMotionCoolingResult>){
 checkExpected(expected)
 const identities=z.array(z.object({path:z.string().min(1),sha256:z.string().regex(/^[0-9a-f]{64}$/)})).parse(raw)
 const paths=new Map<string,MotionCoolingArtifact>()
 for(const identity of identities){
  const path=resolve(identity.path),inside=relative(resolve(directory),path)
  if(!isAbsolute(identity.path)||inside==='..'||inside.startsWith('../')||isAbsolute(inside)||paths.has(path))
   throw Error('Duplicate or outside retained motion artifact path')
  paths.set(path,identity)
 }
 async function required(name:string){
  const path=resolve(directory,name),identity=paths.get(path)
  if(!identity)throw Error('Missing retained motion artifact '+name)
  const bytes=await Bun.file(path).bytes()
  if(createHash('sha256').update(bytes).digest('hex')!==identity.sha256)throw Error('Retained motion artifact hash changed '+name)
  return bytes
 }
 async function continuation(base:string,time:number){
  const supportBytes=await required(base+'.bin.motion-support.txt'),modeBytes=await required(base+'.bin.mode.txt'),
   supportFrame=inspectMotionCoolingSupport(supportBytes,time),mode=inspectMotionCoolingMode(modeBytes,expected.clusters)
  if(!isDeepStrictEqual(supportFrame.input,mode.input))throw Error('Mechanical mode and finite-support input differ')
  return {supportBytes,modeBytes,mode}
 }
 const normalMotion:number[][]=[]
 for(const arm of ['normal','tighter'] as const){
  let finalCommon:Uint8Array|undefined,finalContinuation:Awaited<ReturnType<typeof continuation>>|undefined
  for(const [i,time]of expected.commonTimes.entries()){
   const base=`${arm}/common-${i}`
   const state=await required(base+'.bin')
   inspectMotionCoolingState(state,expected.unknowns,time)
   const view=new DataView(state.buffer,state.byteOffset,state.byteLength),suffixLength=8*expected.clusters+1,
    motion=Array.from({length:suffixLength},(_,j)=>view.getFloat64(8*(1+expected.unknowns-suffixLength+j),true))
   if(arm==='normal')normalMotion.push(motion)
   else{
    const normal=normalMotion[i]!,receipt=result.tighter.motionComparisons[i]!
    let maximum=0,worst=0
    for(let j=0;j<suffixLength;j++){
     const bound=j===suffixLength-1||j%8>=5?1e-5:1e-7,q=Math.abs(normal[j]!-motion[j]!)/bound
     if(q>maximum){maximum=q;worst=j}
    }
    if(maximum>1||receipt.suffixRow!==worst||receipt.normal!==normal[worst]||receipt.tighter!==motion[worst]||receipt.ratio!==maximum)
     throw Error('Mechanical comparison receipt differs from retained common-time physical vectors')
   }
   if(time===60.5)finalCommon=state
   const retained=await continuation(base,time)
   if(time===60.5)finalContinuation=retained
   const summary=support.parse(JSON.parse(new TextDecoder().decode(await required(base+'.support.json'))))
   if(summary.A.timeS!==time)throw Error('Retained common support time differs')
  }
  const terminal=await required(`${arm}/terminal-admitted.bin`)
  inspectMotionCoolingState(terminal,expected.unknowns,60.5)
  const terminalContinuation=await continuation(`${arm}/terminal-admitted`,60.5)
  if(!finalContinuation||!isDeepStrictEqual(terminalContinuation,finalContinuation))throw Error('Retained terminal changed support/mode continuation')
  if(terminalContinuation.mode.branches.some(b=>b.joint!=='contact'||b.regulator!=='hold-rest'))
   throw Error('Ordinary cold motion did not retain settled Contact/HoldRest branches')
  if(!finalCommon||terminal.some((v,i)=>v!==finalCommon[i]))throw Error('Retained terminal differs from admitted horizon observation')
  const view=new DataView(terminal.buffer,terminal.byteOffset,terminal.byteLength),suffix=result[arm].finalMotion,
   first=1+expected.unknowns-suffix.length
  if(suffix.some((v,i)=>v!==view.getFloat64(8*(first+i),true)))throw Error('Reported final motion differs from retained full physical state')
  const retained=JSON.parse(new TextDecoder().decode(await required(`${arm}/result.json`)))
  if(!isDeepStrictEqual(retained,result[arm]))throw Error('Retained arm result differs from native report')
  for(const snapshot of result[arm].eventSnapshots){
   const base=`${arm}/event-${snapshot.index}`
   inspectMotionCoolingState(await required(base+'.bin'),expected.unknowns,snapshot.time)
   await continuation(base,snapshot.time)
  }
 }
 return identities
}
