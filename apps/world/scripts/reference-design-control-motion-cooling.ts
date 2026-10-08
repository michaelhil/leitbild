/** One frozen accepted-time experiment, using the existing physical compilers.
 * No live plant installation, maintained support or prescribed achieved pose. */
import {createHash} from 'node:crypto'
import {access,mkdir,realpath,writeFile} from 'node:fs/promises'
import {isAbsolute,join,resolve} from 'node:path'
import {prepareMovingFuelCooling,movingFuelCoolingNativeInput} from './reference-design-control-geometry'
import {nativeMovingFuelCoolingFixture} from './reference-design-control-source-motion'
import {compileConnectedControlMotion} from './reference-design-connected-control-motion'
import {controlSourceNativeIdentities} from './reference-design-control-source-stage'
import {helperIdentities} from './reference-design-operating-network'
import {sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {parseMotionCoolingResult,validateMotionCoolingArtifacts,parseMotionCoolingStdout} from './reference-design-control-motion-result'
import {verifySelectedNativeStack,selectedNativeStackUnchanged,type SelectedNativeStack} from './reference-design-native-stack'
import {z} from 'zod'
const sha=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex')
const selectedArtifact=z.object({path:z.string().refine(isAbsolute),sha256:z.string().regex(/^[0-9a-f]{64}$/)})
const selectedStack=z.object({prefix:z.string().refine(isAbsolute),idaLibrary:z.string().refine(isAbsolute),
 configuration:selectedArtifact,linkedLibraries:z.array(selectedArtifact).min(1)})
/** Retain this experiment's actual inputs, not the obsolete build paths in a
 * parent receipt. Link inspection proves selected bytes, not build/source
 * correspondence. The current external IF97 inputs are documentary only. */
export async function retainMotionCoolingInputs(binary:string,evidence:string,directory:string,
 inputs:ReadonlyArray<{path:string,sha256:string}>){
 const path=resolve(process.env.LEITBILD_NATIVE_STACK_MANIFEST??join(evidence,'2026-10-07/source-carrier3-native-stack-1.artifacts/manifest.json')),
  bytes=await Bun.file(path).bytes(),selection={path,sha256:sha(bytes)},
  selected=selectedStack.parse(JSON.parse(new TextDecoder().decode(bytes))),
  currentInputs=['LEITBILD_IF97_DIR','LEITBILD_IF97_BRIDGE_DIR'].map(key=>{
   const value=process.env[key];if(!value?.trim())throw Error('Explicit current documentary build input required: '+key)
   return join(resolve(value),key==='LEITBILD_IF97_DIR'?'IF97.h':'if97-bridge.cpp')
  }),documentaryBuildInputs=await Promise.all(currentInputs.map(async path=>({path,sha256:sha(await Bun.file(path).bytes())}))),
  frozen=new Map<string,string>()
 for(const q of [...inputs,selection,selected.configuration,...selected.linkedLibraries,...documentaryBuildInputs]){
  const path=resolve(q.path),previous=frozen.get(path)
  if(previous!==undefined&&previous!==q.sha256)throw Error('Conflicting frozen input identity '+path)
  frozen.set(path,q.sha256)
 }
 const unchanged=async()=>{
  for(const [path,digest]of frozen)if(sha(await Bun.file(path).bytes())!==digest)throw Error('Frozen input changed '+path)
 }
 await unchanged()
 const nativeStack=await verifySelectedNativeStack({binary,prefix:selected.prefix,idaLibrary:selected.idaLibrary,
  artifacts:[...frozen.keys()],directory:join(directory,'native-stack')})
 await unchanged()
 if(nativeStack.configuration.path!==await realpath(selected.configuration.path)
  ||nativeStack.configuration.sha256!==selected.configuration.sha256)throw Error('Selected native configuration differs')
 if(!await selectedNativeStackUnchanged(nativeStack))throw Error('Retained motion stack changed during preparation')
 return {nativeStack,nativeStackSelection:selection,documentaryBuildInputs}
}
export const motionCoolingAccuracy={burst_s:.5,hold_s:60,maximum_step_s:.1,relative:1e-6,
 position_m:1e-9,velocity_m_s:1e-9,heat_J:1e-7,water_energy_J:1e-7,marker_kg:1e-11}
export async function prepareControlMotionCooling(wiki:string,evidence:string,waterReceipt:string){
 const [prepared,motion]=await Promise.all([prepareMovingFuelCooling(wiki,evidence,waterReceipt),compileConnectedControlMotion(wiki,motionCoolingAccuracy)]),
  {p,plan,source}=prepared,act=p.actuation
 if(!act)throw Error('Moving composition requires one existing ACT.A/PRHR owner')
 // This ordinary motion case uses nominal finite full-charge support, NOT the
 // separate degraded90kJ ACT.A loss/recovery study. Both are explicit cases.
 const actual={...p,actuation:{...act,prep:{...act.prep,initialUsableEnergy_J:act.capacity_J,
  initialChargerAvailable:false,initialBatteryAvailable:true,initialOutputHealthy:true,initialOutputClosed:true,events:[]}}},
  cooling=nativeMovingFuelCoolingFixture(plan,actual,source),fields=movingFuelCoolingNativeInput({...prepared,p:actual,cooling}),
  m=motion.motion,g=motion.cluster,d=motion.dc,a=motion.accuracy,s=motion.initialSupport
 fields.push(m.body_mass_kg,m.stem_mass_kg,m.force_limit_n,m.grip_closed_force_n,m.gap_stroke_m,m.maximum_rate_m_s,m.efficiency,m.joint_capacity_n,
  g.stem_radius_m,g.stem_bottom_m,g.stem_top_m,motion.stemPassages.length,
  ...motion.stemPassages.flatMap(p=>[p.outer_radius_m,p.bottom_m,p.top_m]),
  d.capacity_j,d.normal_group_w,d.charger_limit_w,d.output_limit_w,d.charge_efficiency,d.discharge_efficiency,d.converter_efficiency,
  s.initialEnergy_J,+s.charger,+s.battery,+s.output,1,motion.duty.holding_w,motion.duty.motive_w,motion.duty.base_b_w,m.maximum_rate_m_s,
  a.burst_s,a.hold_s,a.position_m,a.velocity_m_s,a.heat_J,a.relative)
 if(motion.count!==plan.motion.clusters.length||motion.clusterIds.some((q,i)=>q.id!==plan.motion.clusters[i]?.id))
  throw Error('Mechanical/geometry owner order differs')
 const owners=new Map<string,{name:string,sha256:string}>()
 const sourceOwners=await Promise.all(sourceEvolutionOwnerFiles.map(async name=>({name,sha256:sha(await Bun.file(join(wiki,name)).bytes())})))
 for(const q of [...p.ownerIdentities,...motion.ownerIdentities,...sourceOwners]){
  if(owners.has(q.name)&&owners.get(q.name)!.sha256!==q.sha256)throw Error('Physical owner changed '+q.name)
  owners.set(q.name,q)
 }
 const paths=[join(evidence,'2026-10-05/operating-source-fixed-partition.json'),join(evidence,'2026-10-05/operating-source-cold-material-incidence.json'),
  waterReceipt,join(evidence,'2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json')]
 return {fixture:fields.join('\n')+'\n',ownerIdentities:[...owners.values()],mapping:prepared.mapping,
  artifacts:await Promise.all(paths.map(async path=>({path,sha256:sha(await Bun.file(path).bytes())}))),
  compilerLaboratoryAccuracy:a,
  accuracy:{sourceRelative:1e-5,mechanicalRelative:0,mechanicalPosition_m:a.position_m,mechanicalVelocity_m_s:a.velocity_m_s,
   mechanicalHeat_J:a.heat_J,refinement:10,maximumStep_s:null,observationTimes:[...motionCoolingExpected.commonTimes]},
  pairPolicy:{position_m:1e-7,speed_m_s:1e-7,local_heat_J:1e-5,fluid_work_J:1e-5},
  supportPreparation:{A:{...actual.actuation.prep,capacity_J:act.capacity_J},B:{...s,capacity_J:d.capacity_j}},
  counts:{clusters:motion.count,waterOwners:plan.water.length,hydraulicEdges:plan.hydraulic.length},
  scope:'Cold0.5sRATE+60sHOLD;actual all52 mechanics+full98 SOURCE/cooling/pressure;single finite A including PRHR and single finite B. Adiabatic apparatus heat. Neck quasi-steady local incompressible circulation; B controller/loss exports outside ROOM.A. BODY neutron incidence only. No released insertion, hot equipment/neck or live installation.'}
}
export const motionCoolingExpected={unknowns:75344,waterOwners:98,clusters:52,
 commonTimes:[0,.00001,.0001,.001,.01,.1,.25,.5,.75,1,2,5,10,30,60.5]}
export function parseControlMotionCoolingResult(raw:unknown){return parseMotionCoolingResult(raw,motionCoolingExpected)}
async function refuse(path:string){try{await access(path)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}throw Error('Refusing existing evidence '+path)}
if(import.meta.main){
 const [wikiArg,evidenceArg,waterArg,binaryArg,outputArg,budget,...extra]=Bun.argv.slice(2),allowance=Number(budget)
 if(!wikiArg||!evidenceArg||!waterArg||!binaryArg||!outputArg||extra.length||!(allowance>0&&allowance<=180))
  throw Error('Usage: control-motion-cooling <wiki-LD01> <evidence root> <ORIGINAL water receipt> <native binary> <NEW receipt.json> <wall allowance<=180>')
 const start=performance.now(),wiki=resolve(wikiArg),evidence=resolve(evidenceArg),water=resolve(waterArg),binary=resolve(binaryArg),target=resolve(outputArg),
  directory=target+'.artifacts',inputPath=target+'.input'
 await refuse(target);await refuse(inputPath);await mkdir(directory)
 const [nativeSourceIdentities,compilerIdentities,binarySha256]=await Promise.all([
  controlSourceNativeIdentities(),helperIdentities(import.meta.path),Bun.file(binary).bytes().then(sha)]),
  prepared=await prepareControlMotionCooling(wiki,evidence,water),inspect=async()=>{
   if(binarySha256!==sha(await Bun.file(binary).bytes()))throw Error('Native binary changed')
   if(JSON.stringify(nativeSourceIdentities)!==JSON.stringify(await controlSourceNativeIdentities()))throw Error('Native sources changed')
   if(JSON.stringify(compilerIdentities)!==JSON.stringify(await helperIdentities(import.meta.path)))throw Error('Compiler changed')
   for(const q of prepared.ownerIdentities)if(q.sha256!==sha(await Bun.file(join(wiki,q.name)).bytes()))throw Error('Wiki owner changed '+q.name)
   for(const q of prepared.artifacts)if(q.sha256!==sha(await Bun.file(q.path).bytes()))throw Error('Parent evidence changed '+q.path)
  }
 await writeFile(inputPath,prepared.fixture,{flag:'wx'})
 let inspectionError:string|null=null,stdout='',stderr='',nativeExit:number|null=null,result:unknown=null,nativeDiagnostics:unknown[]=[],
  nativeStack:SelectedNativeStack|null=null,nativeStackSelection:{path:string,sha256:string}|null=null,
  documentaryBuildInputs:Array<{path:string,sha256:string}>=[]
 try{
  await inspect()
  const frozen=await retainMotionCoolingInputs(binary,evidence,directory,[
   ...nativeSourceIdentities.map(q=>({...q,path:resolve(import.meta.dir,'../native/process-plant',q.path)})),
   ...compilerIdentities,...prepared.ownerIdentities.map(q=>({path:join(wiki,q.name),sha256:q.sha256})),
   ...prepared.artifacts,{path:binary,sha256:binarySha256},{path:inputPath,sha256:sha(prepared.fixture)}])
  nativeStack=frozen.nativeStack;nativeStackSelection=frozen.nativeStackSelection
  documentaryBuildInputs=frozen.documentaryBuildInputs
  await inspect()
  if(nativeStack.binary.sha256!==binarySha256||!await selectedNativeStackUnchanged(nativeStack))throw Error('Frozen native launch identity changed')
  const remaining=allowance-(performance.now()-start)/1000;if(remaining<=1)throw Error('No remaining native allowance')
  const child=Bun.spawn([binary,String(remaining-1),directory],{stdin:Buffer.from(prepared.fixture),stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>child.kill(),remaining*1000)
  try{[stdout,stderr,nativeExit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])}finally{clearTimeout(timer)}
  if(stdout.trim()){const parsed=parseMotionCoolingStdout(stdout);result=parsed.result;nativeDiagnostics=parsed.diagnostics}
  if(nativeExit===0)parseControlMotionCoolingResult(result)
 }catch(e){inspectionError=String(e)}
 const nativeArtifactIdentities=await Promise.all((await Array.fromAsync(new Bun.Glob('**/*').scan({cwd:directory,onlyFiles:true}))).sort()
  .map(async path=>({path:join(directory,path),sha256:sha(await Bun.file(join(directory,path)).bytes())})))
 if(nativeExit===0&&!inspectionError)try{await validateMotionCoolingArtifacts(nativeArtifactIdentities,directory,motionCoolingExpected,parseControlMotionCoolingResult(result))}catch(e){inspectionError=String(e)}
 // Check even after a native refusal or malformed report; failure must not
 // suppress the final provenance check or claim stable retained inputs.
 try{await inspect();if(nativeStack&&!await selectedNativeStackUnchanged(nativeStack))throw Error('Frozen native inputs changed after execution')}
 catch(e){inspectionError=[inspectionError,String(e)].filter(Boolean).join('; ')}
 const elapsedSeconds=(performance.now()-start)/1000,
  {fixture,...metadata}=prepared
 await writeFile(target,JSON.stringify({...metadata,inputPath,inputSha256:sha(fixture),nativeSourceIdentities,compilerIdentities,
  nativeBinaryPath:binary,binarySha256,nativeStack,nativeStackSelection,documentaryBuildInputs,
  sourceCorrespondence:'not-verified',nativeExit,nativeStderr:stderr,nativeDiagnostics,result,inspectionError,elapsedSeconds,nativeArtifactIdentities,...(result===null?{nativeStdout:stdout}:{})},null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({receipt:target,nativeExit,inspectionError,elapsedSeconds,result}))
 if(nativeExit!==0||inspectionError||elapsedSeconds>allowance)process.exitCode=1
}
