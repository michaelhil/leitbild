/** Actual full-size retained SOURCE stage proof. This is deliberately not a
 * source/coolant/motion integrator or a claimed admitted plant trajectory. */
import {createHash} from 'node:crypto'
import {readFile,writeFile,access,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {z} from 'zod'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {compileControlSourceMotion,controlSourceMotionAt,nativeControlSourceFixture,type ControlSourcePose,
 type ControlSourceMotion,type ControlSourceDirection} from './reference-design-control-source-motion'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileSourceFaces} from './reference-design-source-faces'
import {compileOriginalPassiveGeometry} from './reference-design-source-passive'
import {compileCylinderInputs} from './reference-design-source-cylinder'
import {parseNuclearObservation} from './reference-design-nuclear-observation'
import {helperIdentities} from './reference-design-operating-network'

const sha=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex')
async function refuseOverwrite(path:string){
 try{await access(path)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
 throw Error('Refusing to overwrite current SOURCE evidence '+path)
}
export async function controlSourceNativeIdentities(){
 const root=resolve(import.meta.dir,'../native/process-plant'),paths=['Cargo.toml','Cargo.lock','build.rs','examples/control-source-stage.rs']
 for(const pattern of ['src/**/*.{rs,cpp,c,h}','qualification/**/*.rs'])for await(const path of new Bun.Glob(pattern).scan({cwd:root}))paths.push(path)
 return Promise.all(paths.sort().map(async path=>({path,sha256:sha(await Bun.file(join(root,path)).bytes())})))
}

/** Qualification-only distance to every selected axial clipping breakpoint.
 * The physical geometry owns these intervals; this does not choose a new clip,
 * soften a boundary or replace its exact directional evaluator. */
function differenceBranchBound(plan:ControlSourceMotion,poses:readonly ControlSourcePose[],directions:readonly ControlSourceDirection[]){
 let bound=Infinity,locator=''
 const {d}=plan,c=d.control,
  cut=(cluster:number,motion:'body'|'stem',lo:number,hi:number,bottom:number,top:number,label:string)=>{
   const y=motion==='body'?poses[cluster]!.body_y_m:poses[cluster]!.stem_y_m,v=Math.abs(directions[cluster]![motion])
   if(v===0)return
   for(const endpoint of [lo,hi])for(const plane of [bottom,top]){
    const distance=Math.abs(plane-endpoint-y)/v
    if(distance<bound){bound=distance;locator=label+' cluster='+cluster+' endpoint='+endpoint+' plane='+plane}
   }
  }
 for(const r of plan.motion.rows)for(const s of r.spans)cut(r.cluster,'body',s.lo,s.hi,r.lo,r.hi,'passive')
 for(const r of plan.cylinderRows)if(r.cluster>=0)cut(r.cluster,'body',c.insertedActiveBottom_m,
  c.insertedActiveBottom_m+c.activeLength_m,r.lo,r.hi,'cylinder')
 for(let i=0;i<poses.length;i++){
  cut(i,'body',plan.bottom,plan.top,plan.bottom,plan.top,'guide water and side contact')
  cut(i,'body',plan.bottom,plan.top,plan.top,c.headBottom_m,'upper BODY displacement')
 }
 for(const q of plan.intruders)for(const [lo,hi]of [[plan.activeTop,c.headBottom_m],
  [c.headBottom_m,c.housingTop_m],[c.housingTop_m,c.neckTop_m]])cut(q.cluster,q.motion,q.lo,q.hi,lo!,hi!,'intruder')
 for(const p of plan.patches){
  if(p.guide)cut(p.guide.cluster,'body',plan.bottom,plan.top,p.guide.lo,p.guide.hi,'source guide water')
  for(const h of p.housing??[]){const q=plan.intruders[h.intruder]!
   cut(q.cluster,q.motion,q.lo,q.hi,h.lo,h.hi,'source housing water')}
 }
 // BODY side photon paths use the three real shell/cap intervals in either
 // GUIDE or UPPER; their endpoints need not coincide with a material cell cut.
 for(let i=0;i<poses.length;i++)for(const [lo,hi]of [[plan.bottom,c.insertedActiveBottom_m],
  [c.insertedActiveBottom_m,c.insertedActiveBottom_m+c.activeLength_m],[c.insertedActiveBottom_m+c.activeLength_m,plan.top]]){
  cut(i,'body',lo!,hi!,plan.bottom,plan.top,'guide photon surface')
  cut(i,'body',lo!,hi!,plan.top,c.headBottom_m,'upper photon surface')
 }
 return {maximumDifferenceStepBeforeAxialBranch:bound,locator}
}

export async function prepareControlSourceStage(wiki:string,evidence:string,waterReceipt:string,attainedReceipt:string,epsilon:number){
 if(!Number.isFinite(epsilon)||epsilon<=0)throw Error('Explicit positive SOURCE difference step required')
 const read=(p:string)=>readFile(join(wiki,p),'utf8'),ownerText=await Promise.all(sourceEvolutionOwnerFiles.map(read)),
  documents=new Map(sourceEvolutionOwnerFiles.map((p,i)=>[p,ownerText[i]!])),
  owner=(p:string)=>{const s=documents.get(p);if(s===undefined)throw Error('Missing current SOURCE owner '+p);return s},
  paths=[join(evidence,'2026-10-05/operating-source-fixed-partition.json'),join(evidence,'2026-10-05/operating-source-cold-material-incidence.json'),
   waterReceipt,join(evidence,'2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json')],
  artifacts=await Promise.all(paths.map(p=>readFile(p,'utf8'))),
  source=compileSourceEvolution(artifacts[0]!,artifacts[1]!,artifacts[2]!,documents,JSON.parse(artifacts[3]!).receiving.property),
  p=await compileFuelCooling(wiki),d=parsePrimaryWaterInputs(primaryWaterOwnerFiles.map(owner)),text=owner('systems/reactor/configuration-source-and-history.md'),
  passive=compileOriginalPassiveGeometry(p.material.partition,d,p.material.result,
   compileSourceFaces(p.material.partition,d.gates,[0,0]).faces,text),
  cylinder=compileCylinderInputs(p.material.partition,d,p.material.result,passive,
   parseNuclearObservation(owner('systems/instrumentation/nuclear-observation-apparatus.md')),text),
  plan=compileControlSourceMotion(d,p,passive,cylinder),finite=z.number().finite(),
  receiptText=await readFile(attainedReceipt,'utf8'),attained=z.object({nativeExit:z.literal(0),inspectionError:z.null(),
   frame:z.object({clusterIds:z.array(z.object({id:z.string()}))}),result:z.object({status:z.literal('PASS'),
    normal:z.object({samples:z.array(z.object({time_s:finite,motion:z.array(z.tuple([finite,finite,finite,finite,finite]))})).min(2)})})}).parse(JSON.parse(receiptText)),
  achieved=attained.result.normal.samples.at(-1)!
 if(attained.frame.clusterIds.length!==plan.motion.clusters.length||achieved.motion.length!==plan.motion.clusters.length
  ||plan.motion.clusters.some((c,i)=>c.id!==attained.frame.clusterIds[i]?.id))throw Error('Attained fleet/current SOURCE identity differs')
 const original:ControlSourcePose[]=plan.motion.clusters.map(c=>({clusterId:c.id,body_y_m:0,stem_y_m:0,
  side:'increasing',stem_side:'increasing',contact:'seated'})),actual=original.map((p,i):ControlSourcePose=>({...p,
   body_y_m:achieved.motion[i]![0],stem_y_m:achieved.motion[i]![2],contact:achieved.motion[i]![0]===0?'seated':'offseat'})),
  synthetic=original.map((p,i):ControlSourcePose=>({...p,body_y_m:.003+.00001*i,stem_y_m:.0034+.000005*i,contact:'offseat'})),
  direction=original.map((_,i)=>({body:.3*Math.sin(i+1),stem:.2*Math.cos(i+1)})),
  shift=(sign:number)=>synthetic.map((p,i)=>({...p,body_y_m:p.body_y_m+sign*epsilon*direction[i]!.body,
   stem_y_m:p.stem_y_m+sign*epsilon*direction[i]!.stem})),
  descriptions=[{name:'ORIGINAL seated',poses:original},{name:'Attained actual fleet checkpoint',poses:actual,time_s:achieved.time_s},
   {name:'Synthetic nonuniform unaccepted current-pose trial',poses:synthetic},
   {name:'Positive finite difference unaccepted trial',poses:shift(1)},
   {name:'Negative finite difference unaccepted trial',poses:shift(-1)},{name:'Restore ORIGINAL seated',poses:original}],
  branch=differenceBranchBound(plan,synthetic,direction)
 if(!(epsilon<branch.maximumDifferenceStepBeforeAxialBranch))throw Error('SOURCE difference step crosses selected axial clipping branch: '+JSON.stringify(branch))
 const stages=descriptions.map((q,i)=>controlSourceMotionAt(plan,q.poses,i>=2&&i<=4?direction:undefined)),
  fixture=nativeControlSourceFixture(plan,source,p,stages)
 return {fixture,descriptions,direction,epsilon,differenceBranch:{...branch,
   maximumBodyPerturbation_m:epsilon*Math.max(...direction.map(d=>Math.abs(d.body))),
   maximumStemPerturbation_m:epsilon*Math.max(...direction.map(d=>Math.abs(d.stem)))},ownerIdentities:[...new Map([
  ...sourceEvolutionOwnerFiles.map((name,i)=>[name,{name,sha256:sha(ownerText[i]!)}] as const),
  ...p.ownerIdentities.map(q=>[q.name,q]as const)]).values()],
  artifacts:paths.map((path,i)=>({path,sha256:sha(artifacts[i]!)})),
  attainedReceipt:{path:attainedReceipt,sha256:sha(receiptText)},counts:{regions:plan.immutable.regionIds.length,
   waterOwners:plan.water.length,primaryRows:plan.waterRows.length,passiveRows:plan.passiveRows.length,
   cylinderRows:plan.cylinderRows.length,contacts:plan.contactPlans.length,mobileRoutes:plan.routes.length,
   mobileOrigins:plan.origins.length,originalSourcePhysicalCoordinates:source.counts.evolvedCoordinates,
   originalInternalPrimaryProductCoordinates:2*(source.projection.owners.length-source.material.materialPayload.receiving.nativeOwners.length),
   retainedInternalReceivingProductCoordinates:2*source.material.materialPayload.receiving.nativeOwners.length},
  scope:plan.scope}
}

if(import.meta.main){
 const [wiki,evidence,water,attained,binary,output,budget,differenceStep,...extra]=Bun.argv.slice(2),allowance=Number(budget),epsilon=Number(differenceStep)
 if(!wiki||!evidence||!water||!attained||!binary||!output||extra.length||!(allowance>0&&allowance<=120)||!(epsilon>0&&Number.isFinite(epsilon)))
  throw Error('Usage: control-source-stage <LD01 wiki> <evidence root> <current ORIGINAL water receipt> <attained motion receipt> <native binary> <NEW receipt.json> <wall allowance <=120s> <explicit geometry difference step>')
 const target=resolve(output),inputPath=target+'.input',directory=target+'.artifacts'
 await refuseOverwrite(target);await refuseOverwrite(inputPath);await mkdir(directory)
 const start=performance.now(),[nativeSourceIdentities,compilerIdentities,binarySha256]=await Promise.all([
  controlSourceNativeIdentities(),helperIdentities(import.meta.path),Bun.file(resolve(binary)).bytes().then(sha)]),
  prepared=await prepareControlSourceStage(resolve(wiki),resolve(evidence),resolve(water),resolve(attained),epsilon),
  inspectSources=async()=>{
   try{
    if(binarySha256!==sha(await Bun.file(resolve(binary)).bytes()))return 'Native binary changed during preparation/evaluation'
    if(JSON.stringify(nativeSourceIdentities)!==JSON.stringify(await controlSourceNativeIdentities()))return 'Native sources changed during preparation/evaluation'
    if(JSON.stringify(compilerIdentities)!==JSON.stringify(await helperIdentities(import.meta.path)))return 'TS consumers changed during preparation/evaluation'
    for(const q of prepared.ownerIdentities)if(q.sha256!==sha(await Bun.file(join(resolve(wiki),q.name)).bytes()))
     return 'Wiki physical owner changed during preparation/evaluation '+q.name
    return null
   }catch(e){return 'Cannot verify consumed input identity: '+(e instanceof Error?e.message:String(e))}
  }
 await writeFile(inputPath,prepared.fixture,{flag:'wx'})
 let inspectionError=await inspectSources(),stdout='',stderr='',code:number|null=null,result:unknown=null
 const remaining=allowance-(performance.now()-start)/1000
 if(remaining<=1)inspectionError=inspectionError??'SOURCE preparation left no execution/retained failure allowance'
 if(!inspectionError){
  const child=Bun.spawn([resolve(binary),String(remaining-1),String(prepared.epsilon),directory],{stdin:Buffer.from(prepared.fixture),stdout:'pipe',stderr:'pipe'}),
   timer=setTimeout(()=>child.kill(),remaining*1000)
  try{[stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])}
  finally{clearTimeout(timer)}
 }
 try{if(stdout.trim())result=JSON.parse(stdout)
  if(code===0)z.object({pass:z.literal(true),original_restored:z.literal(true),
   history_bits_unchanged:z.literal(true),invalid_geometry_refused:z.literal(true),
   operator_finite_difference:z.object({pass:z.literal(true)}).passthrough(),
   aggregate_rhs_finite_difference:z.object({acceptance_gate:z.literal(false)}).passthrough(),
   negative_controls:z.object({coefficient:z.object({omitted_rejected:z.literal(true),reversed_rejected:z.literal(true)}).passthrough(),
    assembly:z.object({omitted_rejected:z.literal(true),reversed_rejected:z.literal(true)}).passthrough()}).passthrough()}).passthrough().parse(result)}
 catch(e){inspectionError=e instanceof Error?e.message:String(e)}
 const guardError=await inspectSources()
 if(guardError)inspectionError=[inspectionError,guardError].filter(Boolean).join('; ')
 let nativeArtifactIdentities:{path:string;sha256:string}[]=[]
 try{nativeArtifactIdentities=await Promise.all((await Array.fromAsync(new Bun.Glob('**/*').scan({cwd:directory,onlyFiles:true})))
  .sort().map(async path=>({path:join(directory,path),sha256:sha(await Bun.file(join(directory,path)).bytes())})))}
 catch(e){inspectionError=[inspectionError,'Cannot retain native artifact identity: '+(e instanceof Error?e.message:String(e))].filter(Boolean).join('; ')}
 const elapsedSeconds=(performance.now()-start)/1000,{fixture,...metadata}=prepared,
  receipt={...metadata,inputPath,inputSha256:sha(fixture),nativeSourceIdentities,compilerIdentities,nativeBinaryPath:resolve(binary),binarySha256,
   elapsedSeconds,nativeExit:code,nativeStderr:stderr,result,inspectionError,nativeArtifactIdentities,
   ...(result===null?{nativeStdout:stdout}:{}),
   sourceHistoryAdvanced:false,trajectoryAdmitted:false,liveModelInstalled:false}
 await writeFile(target,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 if(code!==0||inspectionError||elapsedSeconds>allowance)throw Error('Current SOURCE stage proof failed; receipt retained at '+target)
 console.log(JSON.stringify({receipt:target,elapsedSeconds,counts:prepared.counts,result}))
}
