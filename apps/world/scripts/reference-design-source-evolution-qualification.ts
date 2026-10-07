/** One prospective actual-input trajectory pair; no retry/backend ladder. */
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
export const sourceDependencyPath=(base:string,path:string)=>resolve(base,path.endsWith('.ts')?path:path+'.ts')
export function sourceEvolutionOutput(stdout:string){
 const records=stdout.trim()?stdout.trim().split('\n').map(line=>{try{return JSON.parse(line)}catch{return {unparsed:line}}}):[],latest=[...records].reverse()
 return {records,outcome:latest.find(row=>row&&typeof row.passed==='boolean'),
  retainedState:latest.find(row=>row?.kind==='admitted-progress')}
}
const admittedArm=z.object({passed:z.literal(true),lastAdmittedTime:z.literal(300)}),
 admittedPair=z.object({passed:z.literal(true),lastAdmittedTime:z.literal(300),physicalCoordinates:z.number().int().positive(),
  normal:admittedArm,tighter:admittedArm,settings:z.object({horizon:z.literal(300)}),gates:z.object({
   localPairRatio:z.number().finite().nonnegative().max(1),SUMABSFamilyPairRatio:z.number().finite().nonnegative().max(1),
   observablePairRatio:z.number().finite().nonnegative().max(1),comparedFamilyOutputs:z.number().int().positive(),
   developedSignal:z.literal(true),strictAcceptedBoundary:z.literal(true)})})
export async function qualifySourceEvolution(partition:string,material:string,water:string,materialEvidence:string,wiki:string,output:string,artifactFiles:string[],priorControllerReceipt?:string){
 const began=performance.now(),allowanceSeconds=120,
  root=resolve(import.meta.dir,'../native/process-plant'),directory=resolve(output)+'.artifacts',
  paths=[partition,material,water,materialEvidence,materialEvidence+'.artifacts/material.json'].map(p=>resolve(p))
 if(await Bun.file(output).exists())throw Error('Refusing to overwrite existing evidence')
 const priorText=priorControllerReceipt?await Bun.file(priorControllerReceipt).text():undefined,
  prior=priorText?JSON.parse(priorText):undefined,priorControllerSeconds=prior?.elapsedSeconds??0
 if(priorText&&(!prior||typeof prior.elapsedSeconds!=='number'||prior.simulationStarted!==false||prior.artifactsCreated!==false||prior.debitedTo!==basename(output)))throw Error('Invalid prior controller receipt')
 if(!Number.isFinite(priorControllerSeconds)||priorControllerSeconds<0||priorControllerSeconds>=allowanceSeconds)throw Error('Invalid prior controller debit')
 if(!artifactFiles.length||artifactFiles.some(p=>!p.trim()))throw Error('Explicit frozen native dependency artifacts required')
 const artifacts=await Promise.all(artifactFiles.map(async path=>({path:resolve(path),sha256:sha(await readFile(resolve(path)))}))),
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
 const helpers=new Map<string,Uint8Array>(),transpiler=new Bun.Transpiler({loader:'ts'})
 async function retainHelper(path:string){
  if(helpers.has(path))return
  const bytes=await readFile(path);helpers.set(path,bytes)
  for(const entry of transpiler.scanImports(bytes))if(entry.path.startsWith('./reference-design-'))await retainHelper(sourceDependencyPath(import.meta.dir,entry.path))
 }
 await retainHelper(import.meta.path)
 const native=await Array.fromAsync(new Bun.Glob('{src,examples,qualification}/**/*.{rs,cpp}').scan({cwd:root})),
  sourcePaths=[...helpers.keys()].sort().concat(
   ...native.sort().map(p=>join(root,p)),...['Cargo.toml','Cargo.lock','build.rs'].map(p=>join(root,p))),
  sources=await Promise.all(sourcePaths.map(p=>readFile(p)))
 await mkdir(directory)
 await Promise.all(sourcePaths.map((p,i)=>writeFile(join(directory,`${i}-${basename(p)}`),sources[i]!,{flag:'wx'})))
 const execute=async(command:string[],allowanceMs:number)=>{
  if(allowanceMs<=0)return {command,exitCode:null,stdout:'',stderr:'Aggregate allowance exhausted',timedOut:true,elapsedSeconds:0}
  const start=performance.now(),child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},allowanceMs)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,stdout,stderr,exitCode,timedOut,elapsedSeconds:(performance.now()-start)/1000}
 }
 const compilationBegan=performance.now(),toolchain=await execute(['rustc','--version'],10_000),build=await execute([
  'cargo','build','--release','--features','offline-ida','--example','source-evolution-ida','--manifest-path',join(root,'Cargo.toml')],180_000)
 const compilationSeconds=(performance.now()-compilationBegan)/1000
 if(!process.env.CARGO_TARGET_DIR)throw Error('Explicit pinned native target directory required')
 const binary=join(resolve(process.env.CARGO_TARGET_DIR),'release/examples/source-evolution-ida'),
  bytes=build.exitCode===0?await readFile(binary):undefined
 if(bytes)await writeFile(join(directory,'source-evolution-ida'),bytes,{flag:'wx'})
 const preparationBegan=performance.now(),prepared=compileSourceEvolution(texts[0]!,texts[1]!,texts[2]!,
  new Map(sourceEvolutionOwnerFiles.map((p,i)=>[p,texts[paths.length+i]!])),payload.receiving.property),
  preparationSeconds=(performance.now()-preparationBegan)/1000,fixturePath=join(directory,'input.txt')
 if(sha(prepared.material.fixture)!==parent.fixtureSHA256)throw Error('Recompiled physical material differs from admitted parent')
 await writeFile(fixturePath,prepared.fixture,{flag:'wx'})
 const remaining=(allowanceSeconds-priorControllerSeconds)*1000-(performance.now()-began-compilationSeconds*1000),run=bytes?await execute([binary,fixturePath,String(remaining/1000)],remaining):undefined,
  parsed=sourceEvolutionOutput(run?.stdout??''),{outcome,retainedState}=parsed,admission=admittedPair.safeParse(outcome),
  checkpoints=await Promise.all((await Array.fromAsync(new Bun.Glob('*.checkpoint').scan({cwd:directory}))).sort().map(async name=>{
   const path=join(directory,name),bytes=await readFile(path);return {path,sha256:sha(bytes),bytes:bytes.length}
  })),unchanged=(await Promise.all(consumed.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i])
   &&(await Promise.all(sourcePaths.map(p=>readFile(p)))).every((s,i)=>s.equals(sources[i]!))
   &&(await Promise.all(artifacts.map(async q=>sha(await readFile(q.path))===q.sha256))).every(Boolean)
   &&(!priorText||await Bun.file(priorControllerReceipt!).text()===priorText)
   &&(!bytes||sha(await readFile(binary))===sha(bytes)),
  elapsedSeconds=(performance.now()-began)/1000-compilationSeconds+priorControllerSeconds,
  receipt={recordedAt:new Date().toISOString(),passed:toolchain.exitCode===0&&!toolchain.timedOut&&build.exitCode===0&&!build.timedOut&&run?.exitCode===0
   &&!run.timedOut&&admission.success&&admission.data.physicalCoordinates===prepared.counts.evolvedCoordinates&&unchanged&&elapsedSeconds<=allowanceSeconds,
   allowanceSeconds,elapsedSeconds,priorControllerSeconds,
   priorControllerReceipt:priorText?{path:resolve(priorControllerReceipt!),sha256:sha(priorText)}:undefined,
   preparationSeconds,buildSeconds:build.elapsedSeconds,compilationSeconds,
   compilationOutsideAdvancementAllowance:true,totalWallSeconds:(performance.now()-began)/1000,
   counts:prepared.counts,scope:prepared.scope,projectionScope:prepared.projection.scope,
   reactionOmissions:prepared.material.input.reactionOmissions,geometryRecompiled:true,advancedSeconds:outcome?.lastAdmittedTime??retainedState?.lastAdmittedTime??0,
   consumed:consumed.map((path,i)=>({path,sha256:sha(texts[i]!)})),sources:sourcePaths.map((path,i)=>({path,sha256:sha(sources[i]!)})),
   fixtureSHA256:sha(prepared.fixture),binarySHA256:bytes?sha(bytes):undefined,toolchain,build,run,outcome,retainedState,
   termination:run?.timedOut?'external-wall-deadline':outcome?'native-final-result':build.exitCode!==0?'build-failed':'native-final-result-missing',
   admissionError:admission.success?undefined:admission.error.issues,unchanged,
   artifacts:{directory,nativeDependencies:artifacts,checkpoints},noWholePlantReadinessCredit:true}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
if(import.meta.main){
 const [partition,material,water,property,wiki,output,...remaining]=Bun.argv.slice(2),
  debit=remaining.filter(p=>p.startsWith('--prior-controller-receipt=')),artifacts=remaining.filter(p=>!p.startsWith('--prior-controller-receipt='))
 if(debit.length>1)throw Error('Duplicate prior controller debit')
 if(!partition||!material||!water||!property||!wiki||!output||!artifacts.length)throw Error('Expected partition/material/water/material-evidence receipts, LD-01 root, NEW result and frozen native dependency artifacts')
 const r=await qualifySourceEvolution(partition,material,water,property,wiki,output,artifacts,debit[0]?.slice('--prior-controller-receipt='.length))
 // The immutable receipt retains full states and solver evidence. Do not dump
 // those arrays into the console/context merely to report the run's verdict.
 console.log(JSON.stringify({passed:r.passed,elapsedSeconds:r.elapsedSeconds,buildSeconds:r.buildSeconds,
  counts:r.counts,lastAdmittedTime:r.advancedSeconds,termination:r.termination,unchanged:r.unchanged,
  normal:r.outcome?.normal?{passed:r.outcome.normal.passed,reason:r.outcome.normal.reason,
   lastAdmittedTime:r.outcome.normal.lastAdmittedTime,returnedTime:r.outcome.normal.returnedTime,
   wallSeconds:r.outcome.normal.wallSeconds,stats:r.outcome.normal.stats,
   preconditionerMetrics:r.outcome.normal.preconditionerMetrics}:undefined,
  tighter:r.outcome?.tighter?{passed:r.outcome.tighter.passed,reason:r.outcome.tighter.reason,
   lastAdmittedTime:r.outcome.tighter.lastAdmittedTime,wallSeconds:r.outcome.tighter.wallSeconds}:undefined,
  retainedCheckpoint:r.retainedState?{lastAdmittedTime:r.retainedState.lastAdmittedTime,
   path:r.retainedState.checkpointPath}:undefined,output}))
 if(!r.passed)process.exitCode=1
}
