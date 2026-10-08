import {afterEach,describe,expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {inspectMotionCoolingState,inspectMotionCoolingSupport,inspectMotionCoolingMode,parseMotionCoolingResult,parseMotionCoolingStdout,validateMotionCoolingArtifacts,compareControlMaterialSamples} from './reference-design-control-motion-result'

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
function materialSample(time:number){
 // Constant prompt emission and linearly growing Mn emission, each split
 // metal/water/export = 3/2/1. The one synthetic paid row includes both.
 return {time,powersW:[6e-6,3e-6,2e-6,1e-6,6e-10*time,3e-10*time,2e-10*time,1e-10*time],
  paidJ:[6e-6*time+3e-10*time*time],
  receiptsJ:[3e-6*time+1.5e-10*time*time,1e-6*time+.5e-10*time*time] as [number,number]}
}
function motionState(time:number){
 const motion=Array(19).fill(0) as number[],sample=materialSample(time)
 motion[6]=sample.receiptsJ[0];motion[17]=sample.receiptsJ[0];motion[18]=sample.receiptsJ[1]
 return motion
}
function sensitivity(sample:ReturnType<typeof materialSample>){
 const totals=Array(8).fill(0) as number[]
 for(let i=0;i<sample.powersW.length;i++)totals[i%8]!+=sample.powersW[i]!
 const emittedW=totals[0]!+totals[4]!,metal=totals[1]!+totals[5]!,water=totals[2]!+totals[6]!,exported=totals[3]!+totals[7]!
 return [.5,1,2].map(scale=>{
  const metalW=scale===1?metal:emittedW*scale/(scale+1),waterW=scale===1?water:(emittedW-metalW)*2/3,
   exportW=scale===1?exported:emittedW-metalW-waterW
  return {scale,emittedW,metalW,waterW,exportW,familyEmittedW:[totals[0]!,totals[4]!]}
 })
}
function report(){
 const arm=()=>({passed:true,lastAdmittedTime:60.5,solverReturnedTime:60.5,reason:null,seconds:.1,steps:2,
  initialization:{iterations:4,chartIterations:2,hydraulicRateIterations:2,lastAppliedChartCorrectionL2:.01,
   lastWeightedCorrectionScope:'remaining-hydraulic-state-and-all-rates',seconds:.01,lastWeightedCorrectionL2:.02,maxForwardRateResidualMixedUnits:1e-9},
  startupICSeconds:.002,eventICCalls:1,eventICSeconds:.01,maxMechanicalDefectJ:0,maxThermalWorkDefectJ:0,
  structuralTemperaturesK:[300,300+2*(materialSample(60.5).receiptsJ[0]/6)
   /(469.4448+.13480848*300+Math.sqrt((469.4448+.13480848*300)**2+2*.13480848*materialSample(60.5).receiptsJ[0]/6)),300,300],
  finalMotion:motionState(60.5),events:[{time:.5,commandOrSupport:true,requestedRate:0}],comparisons:[] as ReturnType<typeof comparison>[],
  eventSnapshots:[{time:.5,index:0}],
  motionComparisons:[] as {time:number,suffixRow:number,normal:number,tighter:number,difference:number,bound:number,ratio:number}[],
  controlMaterialSamples:expected.commonTimes.map(materialSample),
  controlMaterialComparisons:[] as ReturnType<typeof compareControlMaterialSamples>[],
  controlChordSensitivity:sensitivity(materialSample(60.5)),
  costs:{residuals:5,bases:2,actions:10,recoverable:0,residualSeconds:.01,baseSeconds:.01,actionSeconds:.01,PSeconds:.01,convergence:{},P:{}},
  support:support(60.5)})
 const normal=arm(),tighter=arm()
 tighter.comparisons=expected.commonTimes.filter(t=>t>0).map(comparison)
 tighter.motionComparisons=expected.commonTimes.map(time=>({time,suffixRow:0,normal:0,tighter:0,difference:0,bound:1e-7,ratio:0}))
 tighter.controlMaterialComparisons=tighter.controlMaterialSamples.map((s,i)=>compareControlMaterialSamples(normal.controlMaterialSamples[i]!,s))
 return {status:'PASS',scope:'cold-all52-accepted-motion-full98-SOURCE-water-thermal-single-clock',trajectoryAdmitted:true,
  liveModelInstalled:false,unknowns:20,waterOwners:3,clusters:2,controlSteelHosts:4,controlSteelRoutes:1,controlPaidRows:[[0,1]],elapsedS:.2,normal,tighter}
}
function refreshMaterial(raw:ReturnType<typeof report>){
 for(const arm of ['normal','tighter'] as const)raw[arm].controlChordSensitivity=sensitivity(raw[arm].controlMaterialSamples.at(-1)!)
 raw.tighter.controlMaterialComparisons=raw.tighter.controlMaterialSamples.map((s,i)=>compareControlMaterialSamples(raw.normal.controlMaterialSamples[i]!,s))
 return raw
}
function state(time:number){
 const bytes=new Uint8Array(8*(1+2*expected.unknowns)),view=new DataView(bytes.buffer)
 view.setFloat64(0,time,true);view.setFloat64(8,materialSample(time).paidJ[0]!,true)
 for(const [j,value]of motionState(time).entries())view.setFloat64(8*(2+j),value,true)
 view.setFloat64(8*(1+expected.unknowns),6e-6+6e-10*time,true)
 for(const [j,value]of [[6,3e-6+3e-10*time],[17,3e-6+3e-10*time],[18,1e-6+1e-10*time]] as const)
  view.setFloat64(8*(2+expected.unknowns+j),value,true)
 return bytes
}
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
 test('checks every saved route/family split even when both arms carry the same defect',()=>{
  for(let plane=0;plane<expected.commonTimes.length;plane++)for(const family of [0,1])for(let channel=0;channel<4;channel++){
   const raw=report()
   for(const arm of ['normal','tighter'] as const)raw[arm].controlMaterialSamples[plane]!.powersW[4*family+channel]!+=1e-9
   expect(()=>parseMotionCoolingResult(refreshMaterial(raw),expected)).toThrow('route/family nuclear energy closure')
  }
 })
 test('opposite route or family energy defects cannot cancel into a valid aggregate',()=>{
  for(const oppositeFamily of [false,true]){
   const raw=report();raw.controlSteelRoutes=2
   for(const arm of ['normal','tighter'] as const){
    for(const sample of raw[arm].controlMaterialSamples){const half=sample.powersW.map(v=>v/2);sample.powersW=[...half,...half]}
    const channels=raw[arm].controlMaterialSamples.at(-1)!.powersW
    channels[1]!+=1e-9;channels[oppositeFamily?5:9]!-=1e-9
   }
   expect(()=>parseMotionCoolingResult(refreshMaterial(raw),expected)).toThrow('route/family nuclear energy closure')
  }
 })
 test('requires independently meaningful prompt and Mn metal delivery, not an all-zero PASS',()=>{
  for(const family of [0,1]){
   const raw=report()
   for(const arm of ['normal','tighter'] as const)for(const sample of raw[arm].controlMaterialSamples)
    sample.powersW.fill(0,4*family,4*family+4)
   expect(()=>parseMotionCoolingResult(refreshMaterial(raw),expected)).toThrow('not resolved above paired uncertainty')
  }
  const raw=report()
  for(const arm of ['normal','tighter'] as const){
   const channels=raw[arm].controlMaterialSamples.at(-1)!.powersW
   channels.splice(4,4,...(arm==='normal'?[2e-10,1e-10,6e-11,4e-11]:[2e-10,1.1e-10,5e-11,4e-11]))
  }
  refreshMaterial(raw)
  expect(raw.tighter.controlMaterialComparisons.at(-1)!.ratio).toBeLessThan(1)
  expect(()=>parseMotionCoolingResult(raw,expected)).toThrow('not resolved above paired uncertainty')
 })
 test('binds prompt and Mn emission independently at every held optical sensitivity',()=>{
  for(const arm of ['normal','tighter'] as const)for(let chord=0;chord<3;chord++){
   const raw=report(),families=raw[arm].controlChordSensitivity[chord]!.familyEmittedW
   families[0]!+=1e-9;families[1]!-=1e-9
   expect(()=>parseMotionCoolingResult(raw,expected)).toThrow('family emission differs')
  }
  const raw=report(),nominal=raw.normal.controlChordSensitivity[1]!
  nominal.metalW+=1e-9;nominal.waterW-=1e-9
  expect(()=>parseMotionCoolingResult(raw,expected)).toThrow('Nominal sensitivity differs')
 })
 test('requires explicit startup IC timing and all finite in-domain structural temperatures',()=>{
  for(const arm of ['normal','tighter'] as const){
   const raw=report(),{startupICSeconds,...missing}=raw[arm]
   expect(startupICSeconds).toBeGreaterThanOrEqual(0)
   expect(()=>parseMotionCoolingResult({...raw,[arm]:missing},expected)).toThrow()
   for(const invalid of [-1,Infinity,NaN]){
    const changed=report();changed[arm].startupICSeconds=invalid
    expect(()=>parseMotionCoolingResult(changed,expected)).toThrow()
   }
   const absent=report(),{structuralTemperaturesK,...missingTemperature}=absent[arm]
   expect(structuralTemperaturesK).toHaveLength(2*expected.clusters)
   expect(()=>parseMotionCoolingResult({...absent,[arm]:missingTemperature},expected)).toThrow()
   const short=report();short[arm].structuralTemperaturesK.pop()
   expect(()=>parseMotionCoolingResult(short,expected)).toThrow()
   for(const invalid of [289,1601,Infinity,NaN]){
    const changed=report();changed[arm].structuralTemperaturesK[0]=invalid
    expect(()=>parseMotionCoolingResult(changed,expected)).toThrow()
   }
  }
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
 test('binds independent paid progress and both nuclear receipts to their retained stocks',async()=>{
  const {directory,identities}=await artifacts()
  for(const arm of ['normal','tighter'] as const)for(const field of ['paid','transfer','export'] as const){
   const parsed=parseMotionCoolingResult(report(),expected),sample=parsed[arm].controlMaterialSamples[1]!
   if(field==='paid')sample.paidJ[0]!+=1e-12
   else sample.receiptsJ[field==='transfer'?0:1]+=1e-12
   await expect(validateMotionCoolingArtifacts(identities,directory,expected,parsed)).rejects.toThrow('Control paid progress/transfer/export differs')
  }
  const raw=report();raw.controlPaidRows[0]![1]=2
  await expect(validateMotionCoolingArtifacts(identities,directory,expected,parseMotionCoolingResult(raw,expected))).rejects.toThrow('Control paid progress/transfer/export differs')
 })
 test('a rehashed physical paid-stock tamper cannot be covered by unchanged material summaries',async()=>{
  const {directory,identities}=await artifacts(),identity=identities.find(a=>a.path.endsWith('/normal/common-1.bin'))!,bytes=state(.5),
   view=new DataView(bytes.buffer)
  view.setFloat64(8,view.getFloat64(8,true)+1e-12,true)
  await writeFile(identity.path,bytes);identity.sha256=createHash('sha256').update(bytes).digest('hex')
  await expect(validateMotionCoolingArtifacts(identities,directory,expected,parseMotionCoolingResult(report(),expected))).rejects.toThrow('Control paid progress/transfer/export differs')
 })
})
