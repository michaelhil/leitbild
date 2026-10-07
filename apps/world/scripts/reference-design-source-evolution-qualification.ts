/** One prospective actual-input trajectory pair; no retry/backend ladder. */
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {verifySelectedNativeStack,selectedNativeStackUnchanged,requireControlledLoaderEnvironment,type SelectedNativeStack} from './reference-design-native-stack'
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
export const sourceDependencyPath=(base:string,path:string)=>resolve(base,path.endsWith('.ts')?path:path+'.ts')
/** Materialize native getters and normalize Bun's runtime bigint microseconds
 * to JSON numbers. Missing measurements remain explicitly unevaluated. */
export const sourceProcessUsage=(usage:Bun.ResourceUsage|undefined)=>usage?{
 cpuSeconds:{user:Number(usage.cpuTime.user)/1e6,system:Number(usage.cpuTime.system)/1e6,total:Number(usage.cpuTime.total)/1e6},
 peakRSSBytes:Number(usage.maxRSS)
}:{cpuSeconds:null,peakRSSBytes:null}
export function sourceEvolutionOutput(stdout:string){
 const records=stdout.trim()?stdout.trim().split('\n').map(line=>{try{return JSON.parse(line)}catch{return {unparsed:line}}}):[],latest=[...records].reverse()
 return {records,outcome:latest.find(row=>row&&typeof row.passed==='boolean'),
  retainedState:latest.find(row=>row?.kind==='admitted-progress')}
}
/** Retain transitive local engineering helpers, not a manually maintained list. */
export async function sourceHelperFiles(entries:string[]){
 const helpers=new Map<string,Uint8Array>(),transpiler=new Bun.Transpiler({loader:'ts'})
 async function retain(path:string){
  if(helpers.has(path))return
  const bytes=await readFile(path);helpers.set(path,bytes)
  for(const entry of transpiler.scanImports(bytes))if(entry.path.startsWith('./reference-design-'))await retain(sourceDependencyPath(import.meta.dir,entry.path))
 }
 for(const path of entries)await retain(path)
 return helpers
}
/** Frozen, nonadvancing complete-stage gate. The external deadline also covers
 * native factorization, which cannot be interrupted by Rust phase checks. */
export async function auditSourceStage(binary:string,fixture:string,state:string,cj:number,output:string){
 if(!Number.isFinite(cj)||cj<=0)throw Error('Positive finite stage coefficient required')
 return recordSourceCheck([resolve(binary),resolve(fixture),'--audit-block',resolve(state),String(cj)],
  [resolve(binary),resolve(fixture),resolve(state)],output,'stage')
}
export async function inspectSourceStructure(binary:string,fixture:string,output:string){
 return recordSourceCheck([resolve(binary),resolve(fixture),'--structure'],[resolve(binary),resolve(fixture)],output,'structure')
}
async function recordSourceCheck(command:string[],inputsPaths:string[],output:string,kind:'stage'|'structure'){
 if(await Bun.file(output).exists())throw Error('Refusing to overwrite existing evidence')
 const root=resolve(import.meta.dir,'../native/process-plant'),directory=resolve(output)+'.artifacts',
  native=await Array.fromAsync(new Bun.Glob('{src,examples,qualification}/**/*.{rs,cpp,c,h}').scan({cwd:root})),
  paths=[...inputsPaths,import.meta.path,
   ...native.sort().map(p=>join(root,p)),...['Cargo.toml','Cargo.lock','build.rs'].map(p=>join(root,p))],
  inputs=await Promise.all(paths.map(async path=>({path,bytes:await readFile(path)})))
 await mkdir(directory)
 await Promise.all(inputs.map((q,i)=>writeFile(join(directory,`${i}-${basename(q.path)}`),q.bytes,{flag:'wx'})))
 const allowanceSeconds=30,start=performance.now(),child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'})
 let timedOut=false
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},allowanceSeconds*1000)
 const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer)),
  elapsedSeconds=(performance.now()-start)/1000,parsed=sourceEvolutionOutput(stdout),
  unchanged=(await Promise.all(inputs.map(async q=>sha(await readFile(q.path))===sha(q.bytes)))).every(Boolean),
  cases=parsed.records.filter(r=>r?.kind==='direct-stage-audit-case'),
  passed=exitCode===0&&!timedOut&&elapsedSeconds<=allowanceSeconds&&unchanged&&parsed.outcome?.passed===true&&(kind==='structure'
   ?parsed.outcome.kind==='source-structure-final':parsed.outcome.kind==='direct-stage-audit-final'
    &&cases.length===2&&cases[0].case==='original'&&cases[1].case==='captured'),
  receipt={recordedAt:new Date().toISOString(),passed,command,allowanceSeconds,elapsedSeconds,
   exitCode,timedOut,stdout,stderr,...sourceProcessUsage(child.resourceUsage()),
   ...parsed,unchanged,consumed:inputs.map(q=>({path:q.path,sha256:sha(q.bytes),bytes:q.bytes.length})),
   artifacts:{directory},check:kind,compilationExcluded:true,noAdvancement:true,noWholePlantReadinessCredit:true}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
const admittedArm=z.object({passed:z.literal(true),lastAdmittedTime:z.literal(300)})
export const sourcePairAdmission=z.object({passed:z.literal(true),lastAdmittedTime:z.literal(300),physicalCoordinates:z.number().int().positive(),
  normal:admittedArm,tighter:admittedArm,settings:z.object({horizon:z.literal(300),accuracyPolicy:z.literal('source-consequences-1'),
   provisional:z.literal(true),absoluteToleranceRefinement:z.literal(10),rtol:z.tuple([z.literal(1e-5),z.literal(1e-6)])}),gates:z.object({
   fullPairComparisonEvaluated:z.literal(true),NCOperatorPairRatio:z.number().finite().nonnegative().max(1),
   localPairRatio:z.number().finite().nonnegative().max(1),SUMABSFamilyPairRatio:z.number().finite().nonnegative().max(1),
   observablePairRatio:z.number().finite().nonnegative().max(1),comparedFamilyOutputs:z.number().int().positive(),
   developedSignal:z.literal(true),strictAcceptedBoundary:z.literal(true)})})
/** Prior work consumes time regardless of its result. It supplies no state,
 * authority or admission; the receipt is frozen with the same local job. */
export function priorSourceComputationSeconds(prior:unknown,output:string){
 const r=z.object({elapsedSeconds:z.number().finite().nonnegative(),debitedTo:z.literal(basename(output))}).parse(prior)
 if(r.elapsedSeconds>=120)throw Error('Source computation allowance already exhausted')
 return r.elapsedSeconds
}
export async function qualifySourceEvolution(partition:string,material:string,water:string,materialEvidence:string,wiki:string,output:string,artifactFiles:string[],priorComputationReceipt?:string,selectedIdaLibrary?:string){
 const began=performance.now(),allowanceSeconds=120,
  root=resolve(import.meta.dir,'../native/process-plant'),directory=resolve(output)+'.artifacts',
  paths=[partition,material,water,materialEvidence,materialEvidence+'.artifacts/material.json'].map(p=>resolve(p))
 if(await Bun.file(output).exists())throw Error('Refusing to overwrite existing evidence')
 const priorText=priorComputationReceipt!==undefined?await Bun.file(priorComputationReceipt).text():undefined,
  priorComputationSeconds=priorText!==undefined?priorSourceComputationSeconds(JSON.parse(priorText),output):0
 if(!artifactFiles.length||artifactFiles.some(p=>!p.trim()))throw Error('Explicit frozen native dependency artifacts required')
 if(!selectedIdaLibrary?.trim()||!process.env.LEITBILD_SUNDIALS_PREFIX?.trim())throw Error('Explicit selected IDA library and LEITBILD_SUNDIALS_PREFIX required')
 if(!process.env.CARGO_TARGET_DIR?.trim())throw Error('Explicit pinned native target directory required before compilation')
 const prefix=resolve(process.env.LEITBILD_SUNDIALS_PREFIX),if97=process.env.LEITBILD_IF97_DIR,bridge=process.env.LEITBILD_IF97_BRIDGE_DIR
 if(!if97?.trim()||!bridge?.trim())throw Error('Explicit IF97 header/bridge directories required')
 const nativeBuildInputs=[...artifactFiles,...(await Array.fromAsync(new Bun.Glob('**/*.h').scan({cwd:join(prefix,'include')}))).sort().map(p=>join(prefix,'include',p)),
  join(resolve(if97),'IF97.h'),join(resolve(if97),'LICENSE'),join(resolve(bridge),'if97-bridge.cpp')],
  artifacts=await Promise.all([...new Set(nativeBuildInputs.map(p=>resolve(p)))].map(async path=>({path,sha256:sha(await readFile(path))}))),
  ownerPaths=sourceEvolutionOwnerFiles.map(p=>join(resolve(wiki),p)),consumed=[...paths,...ownerPaths],
  texts=await Promise.all(consumed.map(p=>Bun.file(p).text())),parent=JSON.parse(texts[3]!),payload=JSON.parse(texts[4]!)
 if(parent.passed!==true||parent.artifacts?.directory!==resolve(materialEvidence)+'.artifacts')throw Error('Unadmitted receiving property parent')
 if(!parent.consumed?.some((q:{path:string,sha256:string})=>q.path===paths[2]&&q.sha256===sha(texts[2]!)))
  throw Error('Primary water differs from the admitted material parent')
 // Retained native property output is immutable evidence, not an imported
 // material result: actual current geometry/laws are recompiled below.
 const propertyPath=join(parent.artifacts.directory,'receiving-output.ndjson'),propertyText=await Bun.file(propertyPath).text(),
  propertyRows=propertyText.trim().split('\n')
 if(propertyRows.length!==1||JSON.stringify(JSON.parse(propertyRows[0]!))!==JSON.stringify(payload.receiving.property))
  throw Error('Retained native property evidence differs from preparation')
 consumed.push(propertyPath);texts.push(propertyText)
 const helpers=await sourceHelperFiles([import.meta.path])
 const native=await Array.fromAsync(new Bun.Glob('{src,examples,qualification}/**/*.{rs,cpp,c,h}').scan({cwd:root})),
  sourcePaths=[...helpers.keys()].sort().concat(
   ...native.sort().map(p=>join(root,p)),...['Cargo.toml','Cargo.lock','build.rs'].map(p=>join(root,p))),
  sources=await Promise.all(sourcePaths.map(p=>readFile(p)))
 await mkdir(directory)
 await Promise.all(sourcePaths.map((p,i)=>writeFile(join(directory,`${i}-${basename(p)}`),sources[i]!,{flag:'wx'})))
 const execute=async(command:string[],allowanceMs:number)=>{
  requireControlledLoaderEnvironment(process.env)
  if(allowanceMs<=0)return {command,exitCode:null,stdout:'',stderr:'Aggregate allowance exhausted',timedOut:true,elapsedSeconds:0}
  const start=performance.now(),child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},allowanceMs)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,stdout,stderr,exitCode,timedOut,elapsedSeconds:(performance.now()-start)/1000,
   ...sourceProcessUsage(child.resourceUsage())}
 }
 const compilationBegan=performance.now(),toolchain=await execute(['rustc','--version'],10_000),build=await execute([
  'cargo','build','--release','--features','offline-ida','--example','source-evolution-ida','--manifest-path',join(root,'Cargo.toml')],180_000)
 const compilationSeconds=(performance.now()-compilationBegan)/1000
 const binary=join(resolve(process.env.CARGO_TARGET_DIR),'release/examples/source-evolution-ida'),
  bytes=build.exitCode===0?await readFile(binary):undefined
 if(bytes)await writeFile(join(directory,'source-evolution-ida'),bytes,{flag:'wx'})
 let nativeStack:SelectedNativeStack|undefined,nativeStackError:string|undefined
 if(bytes)try{
  nativeStack=await verifySelectedNativeStack({binary,prefix,
   idaLibrary:selectedIdaLibrary,artifacts:artifacts.map(a=>a.path),directory:join(directory,'native-stack')})
  if(!(await Promise.all(artifacts.map(async a=>sha(await readFile(a.path))===a.sha256))).every(Boolean))
   throw Error('Native build inputs changed during compilation/inspection')
  if(nativeStack.binary.sha256!==sha(bytes))throw Error('Binary changed during selected-stack inspection')
 }catch(error){nativeStack=undefined;nativeStackError=String(error)}
 const stackStable=async()=>{
  if(!nativeStack)return false
  try{
   const stable=await selectedNativeStackUnchanged(nativeStack)
    &&(await Promise.all(artifacts.map(async a=>sha(await readFile(a.path))===a.sha256))).every(Boolean)
   if(!stable)nativeStackError='Selected native build/link inputs changed'
   return stable
  }catch(error){nativeStackError=String(error);return false}
 }
 const preparationBegan=performance.now(),prepared=compileSourceEvolution(texts[0]!,texts[1]!,texts[2]!,
  new Map(sourceEvolutionOwnerFiles.map((p,i)=>[p,texts[paths.length+i]!])),payload.receiving.property),
  preparationSeconds=(performance.now()-preparationBegan)/1000,fixturePath=join(directory,'input.txt')
 if(sha(prepared.material.fixture)!==parent.fixtureSHA256)throw Error('Recompiled physical material differs from admitted parent')
 await writeFile(fixturePath,prepared.fixture,{flag:'wx'})
 const launchStackUnchanged=await stackStable(),
  remaining=(allowanceSeconds-priorComputationSeconds)*1000-(performance.now()-began-compilationSeconds*1000),run=bytes&&nativeStack&&launchStackUnchanged?await execute([binary,fixturePath,String(remaining/1000)],remaining):undefined,
  parsed=sourceEvolutionOutput(run?.stdout??''),{outcome,retainedState}=parsed,admission=sourcePairAdmission.safeParse(outcome),
  checkpoints=await Promise.all((await Array.fromAsync(new Bun.Glob('*.checkpoint').scan({cwd:directory}))).sort().map(async name=>{
   const path=join(directory,name),bytes=await readFile(path);return {path,sha256:sha(bytes),bytes:bytes.length}
  })),commonStates=await Promise.all((await Array.fromAsync(new Bun.Glob('*.checkpoint.common-*.state').scan({cwd:directory}))).sort().map(async name=>{
   const path=join(directory,name),bytes=await readFile(path);return {path,sha256:sha(bytes),bytes:bytes.length,
    role:'LDSRC-CMN-y-only common-time interpolant;not admitted boundary or restart'}
  })),unchanged=(await Promise.all(consumed.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i])
   &&(await Promise.all(sourcePaths.map(p=>readFile(p)))).every((s,i)=>s.equals(sources[i]!))
   &&(priorText===undefined||await Bun.file(priorComputationReceipt!).text()===priorText)
   &&(!bytes||sha(await readFile(binary))===sha(bytes)),
  nativeStackUnchanged=await stackStable(),
  elapsedSeconds=(performance.now()-began)/1000-compilationSeconds+priorComputationSeconds,
  receipt={recordedAt:new Date().toISOString(),passed:toolchain.exitCode===0&&!toolchain.timedOut&&build.exitCode===0&&!build.timedOut&&run?.exitCode===0
   &&!run.timedOut&&admission.success&&admission.data.physicalCoordinates===prepared.counts.evolvedCoordinates&&unchanged&&nativeStackUnchanged&&elapsedSeconds<=allowanceSeconds,
   allowanceSeconds,elapsedSeconds,priorComputationSeconds,
   priorComputationReceipt:priorText!==undefined?{path:resolve(priorComputationReceipt!),sha256:sha(priorText)}:undefined,
   preparationSeconds,buildSeconds:build.elapsedSeconds,compilationSeconds,
   compilationOutsideAdvancementAllowance:true,totalWallSeconds:(performance.now()-began)/1000,
   counts:prepared.counts,scope:prepared.scope,projectionScope:prepared.projection.scope,
   reactionOmissions:prepared.material.input.reactionOmissions,geometryRecompiled:true,advancedSeconds:outcome?.lastAdmittedTime??retainedState?.lastAdmittedTime??0,
   consumed:consumed.map((path,i)=>({path,sha256:sha(texts[i]!)})),sources:sourcePaths.map((path,i)=>({path,sha256:sha(sources[i]!)})),
   fixtureSHA256:sha(prepared.fixture),binarySHA256:bytes?sha(bytes):undefined,toolchain,build,run,outcome,retainedState,
   termination:nativeStackError?'native-stack-refused':run?.timedOut?'external-wall-deadline':outcome?'native-final-result':build.exitCode!==0?'build-failed':'native-final-result-missing',
   admissionError:admission.success?undefined:admission.error.issues,unchanged,
   artifacts:{directory,nativeDependencies:artifacts,nativeStack,nativeStackError,nativeStackUnchanged,checkpoints,commonStates},noWholePlantReadinessCredit:true}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
if(import.meta.main){
 const [partition,material,water,property,wiki,output,...remaining]=Bun.argv.slice(2),
  debit=remaining.filter(p=>p.startsWith('--prior-computation-receipt=')),selected=remaining.filter(p=>p.startsWith('--ida-library=')),
  artifacts=remaining.filter(p=>!p.startsWith('--prior-computation-receipt=')&&!p.startsWith('--ida-library='))
 if(debit.length>1)throw Error('Duplicate prior computation debit')
 if(selected.length!==1||!selected[0]!.slice('--ida-library='.length).trim())throw Error('Exactly one explicit --ida-library=PATH required')
 if(!partition||!material||!water||!property||!wiki||!output||!artifacts.length)throw Error('Expected partition/material/water/material-evidence receipts, LD-01 root, NEW result and frozen native dependency artifacts')
 const r=await qualifySourceEvolution(partition,material,water,property,wiki,output,artifacts,debit[0]?.slice('--prior-computation-receipt='.length),selected[0]!.slice('--ida-library='.length))
 // The immutable receipt retains full states and solver evidence. Do not dump
 // those arrays into the console/context merely to report the run's verdict.
 console.log(JSON.stringify({passed:r.passed,elapsedSeconds:r.elapsedSeconds,buildSeconds:r.buildSeconds,
  counts:r.counts,lastAdmittedTime:r.advancedSeconds,termination:r.termination,unchanged:r.unchanged,
  normal:r.outcome?.normal?{passed:r.outcome.normal.passed,reason:r.outcome.normal.reason,
   lastAdmittedTime:r.outcome.normal.lastAdmittedTime,returnedTime:r.outcome.normal.returnedTime,
   wallSeconds:r.outcome.normal.wallSeconds,stats:r.outcome.normal.stats,
   directJacobian:r.outcome.normal.directJacobian}:undefined,
  tighter:r.outcome?.tighter?{passed:r.outcome.tighter.passed,reason:r.outcome.tighter.reason,
   lastAdmittedTime:r.outcome.tighter.lastAdmittedTime,wallSeconds:r.outcome.tighter.wallSeconds}:undefined,
  retainedCheckpoint:r.retainedState?{lastAdmittedTime:r.retainedState.lastAdmittedTime,
   path:r.retainedState.checkpointPath}:undefined,output}))
 if(!r.passed)process.exitCode=1
}
