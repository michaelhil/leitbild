import {afterEach,describe,expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {inspectMotionCoolingState,inspectMotionCoolingSupport,inspectMotionCoolingMode,parseMotionCoolingResult,parseMotionCoolingStdout,validateMotionCoolingArtifacts} from './reference-design-control-motion-result'

// Small inspection fixtures are not trajectories or substitutes for physics.
const expected={unknowns:20,waterOwners:3,clusters:2,commonTimes:[0,.5,60.5]}
function support(time:number){return {A:{timeS:time,energyJ:100,sourceJ:0,deliveredJ:1,prhrDeliveredJ:.5,
 otherDeliveredJ:.5,lossJ:.1,thermalReceivedJ:.6,outputClosed:true,cause:null,chargerAvailable:false,
 batteryAvailable:true,outputHealthy:true,opening:1,springEnergyJ:10,holding:true,closing:false,nextEventS:null,eventCursor:0},
 B:{energyJ:100,sourceJ:0,deliveredJ:1,lossJ:.1,closed:true},bankHoldingJ:.1,bankMotiveJ:.2,
 nonBankAExportJ:.4,nonBankBExportJ:.8,scope:'one-A-owner-including-PRHR;one-B-owner;A-losses-to-ROOM.A;B-losses-exported-to-omitted-ROOM.B'}}
function comparison(time:number){return {policy:'cold-source-nuclear-heat',provisional:true,fullPairQualified:false,
 source:{comparisonScope:'one-common-time;not-full-pair',accuracyPolicy:'source-consequences-1',time,
 local:{time,source:'native-state-row',index:0,family:'neutrons',normal:1,tighter:1,absoluteDifference:0,bound:1e-3,atol:1e-5,ratio:0},
 SUMABSFamilyPairRatio:0,observablePairRatio:0,comparedFamilyOutputs:1,negligibleFamilyOutputs:0,NCOperatorPairRatio:0,
 rawAtomCountDiagnostic:{localPairRatio:12,SUMABSFamilyPairRatio:12,admission:false}},
 ...Object.fromEntries(['thermalTemperatureRatio','thermalEnergyRatio','thermalSUMABSRatio','networkTemperatureRatio',
 'networkPressureRatio','secondaryMassRatio','SGHeatRatio','prhrPairRatio','carrierConsequenceRatio','depositionLocalRatio',
 'depositionSUMABSRatio','barrelPairRatio','barrelPowerPairRatio','capturePowerLocalRatio','capturePowerSUMABSRatio',
 'capturePaidEnergyRatio','mobileCapturePowerLocalRatio','mobileCapturePowerSUMABSRatio','mobileCapturePaidEnergyRatio',
 'pressurePairRatio','pressureMaterialPairRatio'].map(key=>[key,0])),
 worstCooling:{family:'guide-temperature',row:1,normal:1,tighter:1,difference:0,bound:.1,ratio:0}}}
function report(){
 const arm=()=>({passed:true,lastAdmittedTime:60.5,solverReturnedTime:60.5,reason:null,seconds:.1,steps:2,
  initialization:{iterations:4,chartIterations:2,hydraulicRateIterations:2,lastAppliedChartCorrectionL2:.01,
   lastWeightedCorrectionScope:'remaining-hydraulic-state-and-all-rates',seconds:.01,lastWeightedCorrectionL2:.02,maxForwardRateResidualMixedUnits:1e-9},
  eventICCalls:1,eventICSeconds:.01,maxMechanicalDefectJ:0,maxThermalWorkDefectJ:0,
  finalMotion:Array(17).fill(0),events:[{time:.5,commandOrSupport:true,requestedRate:0}],comparisons:[] as ReturnType<typeof comparison>[],
  eventSnapshots:[{time:.5,index:0}],
  motionComparisons:[] as {time:number,suffixRow:number,normal:number,tighter:number,difference:number,bound:number,ratio:number}[],
  costs:{residuals:5,bases:2,actions:10,recoverable:0,residualSeconds:.01,baseSeconds:.01,actionSeconds:.01,PSeconds:.01,convergence:{},P:{}},
  support:support(60.5)})
 const normal=arm(),tighter=arm()
 tighter.comparisons=expected.commonTimes.filter(t=>t>0).map(comparison)
 tighter.motionComparisons=expected.commonTimes.map(time=>({time,suffixRow:0,normal:0,tighter:0,difference:0,bound:1e-7,ratio:0}))
 return {status:'PASS',scope:'cold-all52-accepted-motion-full98-SOURCE-water-thermal-single-clock',trajectoryAdmitted:true,
  liveModelInstalled:false,unknowns:20,waterOwners:3,clusters:2,elapsedS:.2,normal,tighter}
}
function state(time:number){const bytes=new Uint8Array(8*(1+2*expected.unknowns));new DataView(bytes.buffer).setFloat64(0,time,true);return bytes}
function continuation(time:number){
 const a=Array(34).fill(0);a[0]=time
 const motive=time<.5?1:0,rate=time<.5?.008:0,
  b=[100,20,100,100,.9,.9,.9,0,100,1,0,0,0,0,0,1,1,20+motive,100,0,-1,0,20+motive,1,1,99,
   20,motive,20,rate,.5,0,0,100,1,.008]
 const mode=['SOURCE_MOTION_MODE',expected.clusters,rate,motive,20,
  ...Array.from({length:expected.clusters},()=>[rate===0?'hold-rest':'approach-positive','contact',1,1,0]).flat()].join(' ')
 return {all:[1,time,a.length,...a,...b].join(' '),mode}
}

describe('joined cold motion native report boundary',()=>{
 test('separates existing strict factor diagnostics from exactly one terminal report',()=>{
  const progress=[{kind:'block-factor-start' as const,block:'energy-1',factor:'fixed-pattern-ILU0',rows:10,nonzeros:30,attempt:1},
   {kind:'block-factor-complete' as const,block:'energy-1',status:0,seconds:.01}],
   parsed=parseMotionCoolingStdout([...progress,report()].map(r=>JSON.stringify(r)).join('\n'))
  expect(parsed.diagnostics).toEqual(progress)
  expect(parseMotionCoolingResult(parsed.result,expected).status).toBe('PASS')
  expect(parseMotionCoolingStdout(JSON.stringify({status:'FAIL',trajectoryAdmitted:false,error:'Physical gate refused'})).diagnostics).toHaveLength(0)
 })
 test('rejects malformed, missing, multiple, nonterminal or invented native records',()=>{
  const pass=JSON.stringify(report()),progress=JSON.stringify({kind:'block-factor-complete',block:'energy-1',status:0,seconds:.01})
  for(const stdout of ['',progress,pass+'\n'+pass,pass+'\n'+progress,'log\n'+pass,
   JSON.stringify({kind:'invented',status:'PASS'})+'\n'+pass,JSON.stringify({status:'FAIL',trajectoryAdmitted:true,error:'bad'})])
   expect(()=>parseMotionCoolingStdout(stdout)).toThrow()
 })
 test('retains structured native logs before or after the sole report without hardcoded provenance or message',()=>{
  for(const level of ['WARNING','INFO','DEBUG'] as const)for(const after of [false,true]){
   const log=`[${level}][rank 3][/different/source/path.c:987][DifferentRoutine] A distinct native diagnostic.`,
    pass=JSON.stringify(report()),parsed=parseMotionCoolingStdout(after?pass+'\n'+log:log+'\n'+pass)
   expect(parsed.diagnostics).toEqual([{kind:'sundials-log',level,rank:3,scope:'/different/source/path.c:987',
    label:'DifferentRoutine',message:'A distinct native diagnostic.',raw:log}])
   expect(parseMotionCoolingResult(parsed.result,expected).status).toBe('PASS')
  }
 })
 test('refuses ERROR with PASS in either order while retaining native errors on a failed envelope',()=>{
  const error='[ERROR][rank 0][other-module][SomeRoutine] Native operation refused.',
   pass=JSON.stringify(report()),fail=JSON.stringify({status:'FAIL',trajectoryAdmitted:false,error:'Native refusal'})
  for(const stdout of [error+'\n'+pass,pass+'\n'+error])expect(()=>parseMotionCoolingStdout(stdout)).toThrow()
  expect(parseMotionCoolingStdout(fail+'\n'+error).diagnostics).toHaveLength(1)
 })
 test('rejects malformed or unknown native log records and post-report factor work',()=>{
  const pass=JSON.stringify(report())
  for(const log of ['[NOTICE][rank 0][scope][label] message','[WARNING][rank x][scope][label] message',
   '[WARNING][rank 9007199254740992][scope][label] message','[WARNING][rank 0][][label] message',
   '[WARNING][rank 0][scope][] message','[WARNING][rank 0][scope][label] ',
   '[WARNING] arbitrary warning text','[WARNING][rank 0][scope][label] message\nnot a native record'])
   expect(()=>parseMotionCoolingStdout(pass+'\n'+log)).toThrow()
  expect(()=>parseMotionCoolingStdout(pass+'\n[WARNING][rank 0][scope][label] message\n'
   +JSON.stringify({kind:'block-factor-complete',block:'energy-1',status:0,seconds:.01}))).toThrow()
 })
 test('accepts complete paired output without promoting raw diagnostics or whole-pair scope',()=>{
  const parsed=parseMotionCoolingResult(report(),expected)
  expect(parsed.tighter.comparisons).toHaveLength(2)
  expect(parsed.tighter.comparisons[0]!.source.rawAtomCountDiagnostic.localPairRatio).toBe(12)
  expect(parsed.tighter.comparisons[0]!.fullPairQualified).toBe(false)
 })
 test('rejects invented PASS, failed output, changed identities and scope inflation',()=>{
  expect(()=>parseMotionCoolingResult({pass:true},expected)).toThrow()
  for(const changed of [{status:'FAIL'},{unknowns:21},{waterOwners:4},{clusters:3},{liveModelInstalled:true}])
   expect(()=>parseMotionCoolingResult({...report(),...changed},expected)).toThrow()
 })
 test('requires both exact completed admission and separately reported solver time',()=>{
  for(const arm of ['normal','tighter'] as const)for(const key of ['lastAdmittedTime','solverReturnedTime'] as const){
   const raw=report();raw[arm][key]=.5
   expect(()=>parseMotionCoolingResult(raw,expected)).toThrow()
  }
  const raw=report();raw.normal.passed=false
  expect(()=>parseMotionCoolingResult(raw,expected)).toThrow()
 })
 test('binds every positive-time inherited comparison and all local motion locators',()=>{
  const missing=report();missing.tighter.comparisons.pop()
  expect(()=>parseMotionCoolingResult(missing,expected)).toThrow()
  const reordered=report();reordered.tighter.comparisons.reverse()
  expect(()=>parseMotionCoolingResult(reordered,expected)).toThrow()
  const local=report();local.tighter.motionComparisons[1]!.suffixRow=17
  expect(()=>parseMotionCoolingResult(local,expected)).toThrow()
  const absent=report();absent.tighter.motionComparisons=[]
  expect(()=>parseMotionCoolingResult(absent,expected)).toThrow()
  const weakened=report();weakened.tighter.motionComparisons[0]!.bound=1
  expect(()=>parseMotionCoolingResult(weakened,expected)).toThrow()
 })
 test('rejects a failed inherited gate and nonfinite nested diagnostics',()=>{
  const raw=report();raw.tighter.comparisons[0]!.source.observablePairRatio=1.1
  expect(()=>parseMotionCoolingResult(raw,expected)).toThrow()
  const nested=report();nested.normal.costs.convergence={candidate:{correction:NaN}}
  expect(()=>parseMotionCoolingResult(nested,expected)).toThrow()
 })
 test('requires finite support, initialization phase accounting and ordered events',()=>{
  const raw=report();raw.normal.initialization.chartIterations++
  expect(()=>parseMotionCoolingResult(raw,expected)).toThrow()
  const supportTime=report();supportTime.normal.support.A.timeS=.5
  expect(()=>parseMotionCoolingResult(supportTime,expected)).toThrow()
  const events=report();events.normal.events.unshift({time:1,commandOrSupport:true,requestedRate:0})
  expect(()=>parseMotionCoolingResult(events,expected)).toThrow()
  const snapshot=report();snapshot.normal.eventSnapshots=[]
  expect(()=>parseMotionCoolingResult(snapshot,expected)).toThrow()
 })
})
describe('complete physical motion retention',()=>{
 const directories:string[]=[]
 afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})})
 async function artifacts(){
  const directory=await mkdtemp(join(tmpdir(),'ld01-motion-report-test-'));directories.push(directory)
  const identities:{path:string,sha256:string}[]=[]
  async function add(name:string,bytes:string|Uint8Array){const path=join(directory,name);await writeFile(path,bytes)
   identities.push({path,sha256:createHash('sha256').update(bytes).digest('hex')})}
  for(const arm of ['normal','tighter']){
   await mkdir(join(directory,arm))
   for(const [i,time]of expected.commonTimes.entries()){
    await add(`${arm}/common-${i}.bin`,state(time))
    await add(`${arm}/common-${i}.bin.motion-support.txt`,continuation(time).all)
    await add(`${arm}/common-${i}.bin.mode.txt`,continuation(time).mode)
    await add(`${arm}/common-${i}.support.json`,JSON.stringify(support(time)))
   }
   await add(`${arm}/terminal-admitted.bin`,state(60.5))
   await add(`${arm}/terminal-admitted.bin.motion-support.txt`,continuation(60.5).all)
   await add(`${arm}/terminal-admitted.bin.mode.txt`,continuation(60.5).mode)
   await add(`${arm}/event-0.bin`,state(.5))
   await add(`${arm}/event-0.bin.motion-support.txt`,continuation(.5).all)
   await add(`${arm}/event-0.bin.mode.txt`,continuation(.5).mode)
   await add(`${arm}/result.json`,JSON.stringify(report()[arm as 'normal'|'tighter']))
  }
  return {directory,identities}
 }
 test('requires every full physical state/rate, both terminals and hashed support sidecars',async()=>{
  const {directory,identities}=await artifacts()
  expect(await validateMotionCoolingArtifacts(identities,directory,expected,parseMotionCoolingResult(report(),expected))).toHaveLength(38)
  expect(()=>inspectMotionCoolingState(state(0).subarray(8),expected.unknowns,0)).toThrow()
  expect(()=>inspectMotionCoolingState(state(0),expected.unknowns,.5)).toThrow()
  const bad=state(0);new DataView(bad.buffer).setFloat64(16,Infinity,true)
  expect(()=>inspectMotionCoolingState(bad,expected.unknowns,0)).toThrow()
 })
 test('rejects summary-only support, wrong-time continuation and lost A history',()=>{
  const enc=new TextEncoder(),frame=continuation(.5)
  expect(inspectMotionCoolingSupport(enc.encode(frame.all),.5).bWords).toBe(36)
  expect(()=>inspectMotionCoolingSupport(enc.encode('100 1 0'),.5)).toThrow()
  expect(()=>inspectMotionCoolingSupport(enc.encode(frame.all),0)).toThrow()
  expect(()=>inspectMotionCoolingSupport(enc.encode(frame.all+' 1'),.5)).toThrow()
  expect(inspectMotionCoolingMode(enc.encode(frame.mode),expected.clusters).branches[0]!.joint).toBe('contact')
  expect(()=>inspectMotionCoolingMode(enc.encode(frame.mode),expected.clusters+1)).toThrow()
  expect(()=>inspectMotionCoolingMode(enc.encode(frame.mode.replace('hold-rest','invented')),expected.clusters)).toThrow()
 })
 test('rejects missing terminals, duplicate paths and changed physical bytes',async()=>{
  const {directory,identities}=await artifacts()
  const parsed=parseMotionCoolingResult(report(),expected)
  await expect(validateMotionCoolingArtifacts(identities.filter(a=>!a.path.endsWith('tighter/terminal-admitted.bin')),directory,expected,parsed)).rejects.toThrow()
  await expect(validateMotionCoolingArtifacts([...identities,identities[0]!],directory,expected,parsed)).rejects.toThrow()
  await writeFile(identities[0]!.path,state(.5))
  await expect(validateMotionCoolingArtifacts(identities,directory,expected,parsed)).rejects.toThrow()
 })
 test('rejects complete but unrelated arm summaries and final motion',async()=>{
  const {directory,identities}=await artifacts(),parsed=parseMotionCoolingResult(report(),expected)
  parsed.normal.finalMotion[0]=1e-3
  await expect(validateMotionCoolingArtifacts(identities,directory,expected,parsed)).rejects.toThrow()
  parsed.normal.finalMotion[0]=0;parsed.tighter.steps++
  await expect(validateMotionCoolingArtifacts(identities,directory,expected,parsed)).rejects.toThrow()
 })
 test('binds reported common-time mechanical comparison to retained vectors',async()=>{
  const {directory,identities}=await artifacts(),raw=report(),receipt=raw.tighter.motionComparisons[1]!
  receipt.normal=1e-8;receipt.difference=1e-8;receipt.ratio=receipt.difference/receipt.bound
  await expect(validateMotionCoolingArtifacts(identities,directory,expected,parseMotionCoolingResult(raw,expected))).rejects.toThrow()
 })
})
