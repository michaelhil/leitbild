/** Private pinned IDA dependency comparison. No plant launcher or installation. */
import {createHash} from 'node:crypto'
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import {nativeIdasConsistencyFixture} from './reference-design-idas-consistency'

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
export const pinnedIdaSourceSHA256='f9ca2c11dba3b77ee25ddbc61189677e8ba1c148aff68bdb76a9a5a9bfb91692'
const sources=['ida.c','ida_bbdpre.c','ida_cli.c','ida_ic.c','ida_io.c','ida_ls.c','ida_nls.c'] as const
const libraryNames=['core','nvecserial','sunmatrixband','sunmatrixdense','sunlinsolband','sunlinsoldense','sunnonlinsolnewton'] as const
type Artifact={path:string,retained:string,sha256:string,bytes:number}
type Role='control'|'candidate'
export function idaControlledFixture(source=nativeIdasConsistencyFixture){
 // This eight-coordinate fixture uses only the IDA/IDAS shared IDA* API;
 // no quadrature/sensitivity/adjoint API is consumed. Port exactly one header.
 const header='#include <idas/idas.h>'
 if(source.split(header).length!==2||source.includes('#include <ida/ida.h>'))throw Error('Expected exactly one IDAS fixture header')
 return source.replace(header,'#include <ida/ida.h>')
}
export function idaFixtureOutcome(stdout:string,role:Role){
 const rows=stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
 if(rows.length!==1)throw Error('Expected one controlled fixture result')
 const value=z.object({passed:z.boolean(),candidateRole:z.boolean()}).passthrough().parse(rows[0])
 if(value.candidateRole!==(role==='candidate'))throw Error('Wrong controlled fixture role/result')
 if(value.passed){
  const finite=z.number().finite().nonnegative(),positive=z.number().finite().positive(),
   admitted=z.object({steps:z.number().int().positive(),minimumStepSeconds:positive,maximumStepSeconds:positive,
    maximumAnalyticStateError:finite.max(1e-5),maximumGenuineStageResidualError:finite.max(1e-5),
    maximumInterpolantDerivativeError:finite,maximumStageHistoryDerivativeDifferenceInStepAtolUnits:finite,
    maximumReturnedHistoryStateDifferenceInAtolUnits:finite,freshStageOutputs:z.number().int().positive(),
    interpolantOutputs:z.number().int().positive(),observedOrderStepCounts:z.array(z.number().int().nonnegative()).length(5),wallSeconds:finite}).parse(value)
  if(admitted.maximumStepSeconds<=2*admitted.minimumStepSeconds
   ||admitted.observedOrderStepCounts.filter(n=>n>0).length<2
   ||(role==='candidate'&&admitted.maximumReturnedHistoryStateDifferenceInAtolUnits!==0))throw Error('Controlled fixture coverage/endpoint contract failed')
 }
 return value
}
/** Exact finite C printf %a values. Divide the integer mantissa BEFORE the
 * power of two; a combined negative exponent would underflow subnormals. */
export function c99Hex(value:string){
 const match=/^([+-]?)0x([01])(?:\.([0-9a-f]{0,13}))?p([+-]?\d+)$/i.exec(value)
 if(!match)throw Error('Invalid finite C99 hexadecimal float '+value)
 const fraction=match[3]??'',digits=match[2]!+fraction,exponent=Number(match[4]),
  mantissa=Number.parseInt(digits,16)/16**fraction.length,sign=match[1]==='-'?-1:1
 if(!Number.isSafeInteger(exponent)||!Number.isFinite(mantissa))throw Error('Invalid C99 float magnitude')
 if(mantissa===0)return sign*0
 const result=sign*mantissa*2**exponent
 if(!Number.isFinite(result)||result===0)throw Error('Unrepresentable C99 float '+value)
 return result
}
const hex=z.string().transform(c99Hex),traceRow=z.object({role:z.enum(['first-violation','worst-violation','unconstrained-control','interior-control']),
 row:z.number().int().nonnegative(),constraint:hex,rawFailedMask:z.boolean(),target:hex,ewt:hex,predictor:hex,rawY:hex,rawYP:hex,
 eeBeforeConstraint:hex,eeAfterConstraint:hex,correctedEndpoint:hex,predictedPhi0:hex,retainedPhi0:hex,
 predictionMatches:z.boolean(),oldPhi:z.array(hex)}).strict(),
 trace=z.object({kind:z.literal('ida-history-constraint-trace'),dimension:z.number().int().positive(),step:z.number().int().positive(),
 order:z.number().int().min(1).max(5),time:hex,hUsed:hex,cj:hex,violatedCoordinates:z.number().int().positive(),rows:z.array(traceRow).min(1)}).strict()
/** Arithmetic replay only; does not run or qualify an integrator. */
export function replayIdaHistoryTrace(stderr:string){
 return stderr.split('\n').filter(line=>line.startsWith('{')).flatMap(line=>{
  const record=JSON.parse(line)
  if(record.kind==='ida-history-trace-error')throw Error('Native IDA trace failed: '+record.error)
  if(record.kind!=='ida-history-constraint-trace')return []
  const value=trace.parse(record)
  const rows=value.rows.map(row=>{
   if(row.row>=value.dimension||row.oldPhi.length!==value.order+1||row.ewt<=0
    ||![-2,-1,0,1,2].includes(row.constraint))throw Error('Invalid traced coordinate/constraint')
   let predictor=row.oldPhi[0]!
   for(const p of row.oldPhi.slice(1))predictor+=p
   let retained=row.oldPhi[value.order]!+row.eeAfterConstraint
   for(let j=value.order-1;j>=0;--j)retained=row.oldPhi[j]!+retained
   const raw=predictor+row.eeBeforeConstraint,c=row.constraint,
    mask=Math.abs(c)>1.5?raw*c<=0:Math.abs(c)>.5&&raw*c<0,
    expectedTarget=(((Math.abs(c)>=1.5?1:0)*c)/row.ewt)*.1,
    repairedCorrection=mask?(-predictor+row.target):row.eeAfterConstraint,
    repairedEndpoint=predictor+repairedCorrection,
    same=(a:number,b:number)=>Object.is(a,b)
   if(!same(predictor,row.predictor)||!same(raw,row.rawY)||!same(predictor+row.eeAfterConstraint,row.correctedEndpoint)
    ||!same(retained,row.predictedPhi0)||!same(retained,row.retainedPhi0)||!row.predictionMatches
    ||mask!==row.rawFailedMask||!same(expectedTarget,row.target))throw Error('Actual IDA trace arithmetic did not replay exactly at row '+row.row)
   if(!mask&&(!same(repairedCorrection,row.eeAfterConstraint)||!same(repairedEndpoint,row.rawY)))
    throw Error('Unmasked traced control changed under candidate arithmetic')
   return {...row,replayedPredictor:predictor,replayedRaw:raw,replayedRetained:retained,repairedCorrection,repairedEndpoint,
    maskedNonStrictExactZero:mask&&Math.abs(c)===1?repairedEndpoint===0:null}
  })
  return [{...value,rows,scope:'exact stock-operand arithmetic replay;not candidate advancement'}]
 })
}
async function execute(command:string[],allowanceSeconds:number,cwd?:string){
 if(!Number.isFinite(allowanceSeconds)||allowanceSeconds<=0)throw Error('Positive finite command allowance required')
 const began=performance.now(),child=Bun.spawn(command,{...(cwd===undefined?{}:{cwd}),stdout:'pipe',stderr:'pipe'})
 let timedOut=false
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},allowanceSeconds*1000)
 const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
 const usage=child.resourceUsage()
 return {command,cwd,stdout,stderr,exitCode,timedOut,elapsedSeconds:(performance.now()-began)/1000,
  cpuSeconds:usage?Number(usage.cpuTime.total)/1e6:null,peakRSSBytes:usage?Number(usage.maxRSS):null}
}
type ProcessResult=Awaited<ReturnType<typeof execute>>
export type PreparedIdaConsistency={
 directory:string,sourceRoot:string,prefix:string,inputs:Artifact[],outputs:Artifact[],builds:ProcessResult[],
 libraries:Record<Role,string>,fixtures:Record<Role,string>,preparationSeconds:number,
 compilationSeconds:number,
 numericExecuted:false,pinnedVersion:'7.5.0'
}
async function unchanged(artifacts:Artifact[]){
 return (await Promise.all(artifacts.map(async a=>sha(await readFile(a.path))===a.sha256
  &&sha(await readFile(a.retained))===a.sha256))).every(Boolean)
}
/** Build private control+trace and consistency-candidate libraries. The former
 * is NEVER composed with the consistency patch (both use temporary vectors).
 * Darwin-only inspected compiler/linker contract; no global prefix mutation. */
export async function prepareIdaConsistency(options:{sourceRoot:string,prefix:string,artifactDir:string}):Promise<PreparedIdaConsistency>{
 if(process.platform!=='darwin')throw Error('This inspected private IDA build supports Darwin only')
 const began=performance.now(),sourceRoot=await realpath(resolve(options.sourceRoot)),prefix=await realpath(resolve(options.prefix)),
  directory=resolve(options.artifactDir),native=resolve(import.meta.dir,'../native/process-plant'),
  patches={control:join(native,'qualification/ida_history_trace.patch'),candidate:join(native,'qualification/ida_consistency.patch')},
  include=join(prefix,'include'),lib=join(prefix,'lib'),sourceDirectory=join(sourceRoot,'src/ida')
 if(!options.artifactDir.trim()||directory===sourceRoot||directory.startsWith(sourceRoot+'/')||directory===prefix||directory.startsWith(prefix+'/'))
  throw Error('Private artifact directory must be outside source and installed prefix')
 const original=await readFile(join(sourceDirectory,'ida.c')),
  config=await readFile(join(include,'sundials/sundials_config.h'),'utf8')
 if(sha(original)!==pinnedIdaSourceSHA256||!config.includes('#define SUNDIALS_VERSION "7.5.0"')
  ||!config.includes('#define SUNDIALS_DOUBLE_PRECISION 1')||!config.includes('#define SUNDIALS_INT64_T 1'))
  throw Error('Expected exact pinned IDA7.5 DOUBLE/INT64 source/configuration')
 await mkdir(directory) // fails closed if evidence already exists
 await mkdir(join(directory,'inputs'))
 const inputs:Artifact[]=[],outputs:Artifact[]=[],builds:ProcessResult[]=[]
 const retain=async(path:string,output=false)=>{
  path=await realpath(path)
  const list=output?outputs:inputs,prior=list.find(a=>a.path===path)
  if(prior)return prior
  const bytes=await readFile(path),retained=join(directory,'inputs',`${output?'output':'input'}-${list.length}-${basename(path)}`)
  await writeFile(retained,bytes,{flag:'wx'})
  const result={path,retained,sha256:sha(bytes),bytes:bytes.length};list.push(result);return result
 }
 const run=async(command:string[],cwd?:string)=>{
  const result=await execute(command,180-(performance.now()-began)/1000,cwd);builds.push(result)
  await writeFile(join(directory,`build-${builds.length}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'})
  if(result.exitCode!==0||result.timedOut)throw Error('Private IDA build command failed: '+command[0])
  return result
 }
 const prepared:PreparedIdaConsistency={directory,sourceRoot,prefix,inputs,outputs,builds,
  libraries:{control:'',candidate:''},fixtures:{control:'',candidate:''},preparationSeconds:0,compilationSeconds:0,numericExecuted:false,pinnedVersion:'7.5.0'}
 try{
  for(const path of [import.meta.path,resolve(import.meta.dir,'reference-design-idas-consistency.ts'),
   join(sourceRoot,'LICENSE'),join(sourceRoot,'NOTICE'),join(sourceDirectory,'CMakeLists.txt'),...sources.map(s=>join(sourceDirectory,s)),...Object.values(patches)])await retain(path)
  // Freeze all configured/public and local private project headers, including
  // transitive includes. System C/C++ headers belong to the recorded toolchain.
  for(const base of [include,sourceDirectory,join(sourceRoot,'src/sundials')])
   for(const name of (await Array.fromAsync(new Bun.Glob('**/*.h').scan({cwd:base}))).sort())await retain(join(base,name))
  const libraries=await Promise.all(libraryNames.map(async name=>realpath(join(lib,`libsundials_${name}.dylib`))))
  for(const path of libraries)await retain(path)
  // Resolve actual non-system dynamic dependencies; refuse an unowned search.
  const pending=[...libraries],seen=new Set<string>()
  while(pending.length){
   const path=pending.pop()!;if(seen.has(path))continue;seen.add(path)
   const deps=await run(['otool','-L',path])
   for(const line of deps.stdout.split('\n').slice(2)){
    const dependency=line.trim().split(' (')[0];if(!dependency)continue
    if(dependency.startsWith('/usr/lib/')||dependency.startsWith('/System/Library/'))continue
    const actual=await realpath(dependency)
    if(!actual.startsWith(lib+'/'))throw Error('Unowned dynamic dependency '+dependency+' -> '+actual)
    await retain(actual);pending.push(actual)
   }
  }
  await run(['cc','--version']);await run(['c++','--version'])
  const fixture=join(directory,'fixture.cpp');await writeFile(fixture,idaControlledFixture(),{flag:'wx'});await retain(fixture,true)
  for(const role of ['control','candidate'] as const){
   const roleDir=join(directory,role),privateSource=join(roleDir,'src/ida');await mkdir(privateSource,{recursive:true})
   const body=join(privateSource,'ida.c');await writeFile(body,original,{flag:'wx'})
   const patch=await run(['patch','--batch','--forward','--fuzz=0','-p1','-i',patches[role]],roleDir)
   if(/offset|fuzz|FAILED|Reversed/i.test(patch.stdout+patch.stderr))throw Error('Patch did not match exact pinned source')
   await retain(body,true)
   const library=join(roleDir,'libsundials_ida.dylib'),binary=join(roleDir,'fixture.bin')
   await run(['cc','-std=c99','-O2','-fPIC','-dynamiclib','-I'+include,'-I'+sourceDirectory,'-I'+join(sourceRoot,'src/sundials'),
    body,...sources.slice(1).map(s=>join(sourceDirectory,s)),...libraries,
    '-Wl,-install_name,'+library,'-Wl,-rpath,'+lib,'-o',library])
   await retain(library,true)
   await run(['c++','-std=c++17','-O2','-I'+include,fixture,library,...libraries,'-Wl,-rpath,'+lib,'-o',binary])
   await retain(binary,true);await run(['otool','-L',library]);await run(['otool','-L',binary])
   prepared.libraries[role]=library;prepared.fixtures[role]=binary
  }
  if(!await unchanged([...inputs,...outputs]))throw Error('Private IDA build inputs/artifacts changed')
  prepared.preparationSeconds=(performance.now()-began)/1000
  prepared.compilationSeconds=builds.filter(b=>b.command[0]==='cc'||b.command[0]==='c++').reduce((sum,b)=>sum+b.elapsedSeconds,0)
  await writeFile(join(directory,'preparation.json'),JSON.stringify({...prepared,passed:true,scope:'private compilation only;no numeric or plant qualification'},null,2)+'\n',{flag:'wx'})
  return prepared
 }catch(error){
  await writeFile(join(directory,'preparation-failed.json'),JSON.stringify({...prepared,passed:false,error:String(error),elapsedSeconds:(performance.now()-began)/1000},null,2)+'\n',{flag:'wx'})
  throw error
 }
}
/** Explicit controlled comparison only. No source mission is launched here;
 * caller owns debit of this elapsed work to the next aggregate mission budget. */
export async function runIdaConsistencyFixtures(prepared:PreparedIdaConsistency,allowanceSeconds:number){
 if(!Number.isFinite(allowanceSeconds)||allowanceSeconds<=0||allowanceSeconds>30)throw Error('Controlled comparison requires one positive allowance <=30s')
 const began=performance.now(),runs:Partial<Record<Role,ProcessResult>>={},outcomes:Partial<Record<Role,unknown>>={}
 let error:string|undefined
 try{
  if(!await unchanged([...prepared.inputs,...prepared.outputs]))throw Error('Prepared dependency provenance changed')
  for(const role of ['control','candidate'] as const){
   const remaining=allowanceSeconds-(performance.now()-began)/1000
   if(remaining<=0)throw Error('Controlled comparison aggregate allowance exhausted')
   const result=await execute([prepared.fixtures[role],String(remaining),role],remaining);runs[role]=result
   await writeFile(join(prepared.directory,`fixture-${role}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'})
   const outcome=idaFixtureOutcome(result.stdout,role);outcomes[role]=outcome
   if(result.exitCode!==0||result.timedOut||outcome.passed!==true)throw Error('Controlled fixture rejected '+role)
  }
 }catch(e){error=String(e)}
 const elapsedSeconds=(performance.now()-began)/1000,stable=await unchanged([...prepared.inputs,...prepared.outputs]),
  passed=error===undefined&&stable&&elapsedSeconds<=allowanceSeconds,
  receipt={recordedAt:new Date().toISOString(),passed,pinnedVersion:prepared.pinnedVersion,scope:'controlled adaptive eight-coordinate dependency comparison only;not source or plant advancement',
   allowanceSeconds,elapsedSeconds,runs,outcomes,error,unchanged:stable,prepared,sourceMissionExecuted:false,
   debit:'Caller must charge elapsedSeconds plus any separate actual operand trace to next source-pair aggregate allowance'}
 await writeFile(join(prepared.directory,'comparison.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
