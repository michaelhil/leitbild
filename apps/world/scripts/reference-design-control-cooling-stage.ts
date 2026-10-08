/** Full existing SOURCE/cooling model at current control poses. This is a
 * consistency/constitutive qualification, not an accepted-time trajectory. */
import {createHash} from 'node:crypto'
import {access,mkdir,readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {z} from 'zod'
import {prepareMovingFuelCooling} from './reference-design-control-geometry'
import {sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {nativeControlSourcePlan,type ControlSourcePose} from './reference-design-control-source-motion'
import {controlSourceNativeIdentities} from './reference-design-control-source-stage'
import {helperIdentities} from './reference-design-operating-network'

const sha=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex')
const finite=z.number().finite()
const nonnegative=finite.nonnegative(),positive=finite.positive()
const matrix=z.object({rows:z.number().int().positive(),entries:z.number().int().positive(),cj:z.literal(1),
 seconds:nonnegative,maxContributorScaledBackwardError:nonnegative}).passthrough()
const directional=z.object({epsilonM:positive,relativeDiscrimination:positive,seconds:nonnegative,
 countRHSStatus:z.literal('diagnostic-only;coefficient-and-assembly-qualification-is-separate'),
 groups:z.array(z.object({name:z.string().min(1),checkedFields:z.number().int().positive(),
  nonzeroAnalyticFields:z.number().int().nonnegative(),acceptanceGate:z.boolean(),maxRatio:nonnegative,
  worstRow:z.number().int().nonnegative(),absoluteDifference:nonnegative,analytic:finite,finiteDifference:finite})).min(1)})

/** Validate the actual native report, not a second invented PASS envelope.
 * Numerical gates are owned by the identified native executable; this boundary
 * checks completeness, identities and the deliberately non-trajectory scope. */
export function parseControlCoolingStageResult(raw:unknown,expected:{waterOwners:number,clusters:number,cases:number,directionalCases:number[]}){
 const result=z.object({status:z.literal('PASS'),
  scope:z.literal('full-PRHR-SOURCE-cooling-current-stage-and-joint-consistency;not-a-trajectory'),
  waterOwners:z.literal(expected.waterOwners),controlClusters:z.literal(expected.clusters),unknowns:z.number().int().positive(),
  sourceHistoryAdvanced:z.literal(false),trajectoryAdmitted:z.literal(false),mechanicalDynamicsJoined:z.literal(false),
  stemNeckDragJoined:z.literal(false),liveModelInstalled:z.literal(false),elapsedS:nonnegative,
  cases:z.array(z.object({case:z.number().int().nonnegative(),seconds:nonnegative,fixedDifferentialStocksBitwisePreserved:z.literal(true),
   initialization:z.object({iterations:z.number().int().positive(),chartIterations:z.number().int().positive(),
    hydraulicRateIterations:z.number().int().positive(),lastAppliedChartCorrectionL2:nonnegative,
    lastWeightedCorrectionScope:z.literal('remaining-hydraulic-state-and-all-rates'),seconds:nonnegative,lastWeightedCorrectionL2:nonnegative,
    maxForwardRateResidualMixedUnits:nonnegative}).passthrough(),preparedZeroFlowMatrix:matrix,matrix,
   geometryJVP:directional.nullable(),work:z.object({fluidPressureWorkW:finite,fluidWallWorkW:finite,
    oppositeMechanicalPowerW:finite,reciprocalDefectW:finite,composedEnergyDefectAfterMechanicalWorkW:finite,
    bodyFluidForcesN:z.array(finite).length(expected.clusters),stemBuoyancyOnlyN:z.array(finite).length(expected.clusters),
    stemNeckDragJoined:z.literal(false)}),
   preparedLowerMouthSlopesPaPerKgS:z.array(finite).length(expected.clusters),
   lowerMouthSlopesPaPerKgS:z.array(finite).length(expected.clusters),
   currentAdmission:z.object({chart:z.tuple([nonnegative,nonnegative]),pressureSplit:z.tuple([nonnegative,nonnegative,nonnegative]),
    bulkSpeedMPerS:nonnegative,movingWallSpeedMPerS:nonnegative,movingProfileSpeedBoundMPerS:nonnegative,
    dynamicHeadPa:nonnegative,omittedKineticEnergyBoundJ:nonnegative})})).length(expected.cases)}).parse(raw)
 for(const [i,c]of result.cases.entries()){
  if(c.case!==i)throw Error('Current-stage case identity/order differs')
  if(c.initialization.chartIterations+c.initialization.hydraulicRateIterations!==c.initialization.iterations)
   throw Error('Current-stage initialization phase counts differ from total')
  if(expected.directionalCases.includes(i)!==(c.geometryJVP!==null))throw Error('Current-stage geometry direction evidence is missing or unexpected')
 }
 return result
}
async function refuseOverwrite(path:string){
 try{await access(path)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
 throw Error('Refusing to overwrite composed control/cooling evidence '+path)
}

export async function prepareControlCoolingStage(wiki:string,evidence:string,waterReceipt:string,attainedReceipt:string){
 const prepared=await prepareMovingFuelCooling(wiki,evidence,waterReceipt),{plan,p,cooling:remapped}=prepared,
  ownerText=await Promise.all(sourceEvolutionOwnerFiles.map(path=>readFile(join(wiki,path),'utf8'))),
  paths=[join(evidence,'2026-10-05/operating-source-fixed-partition.json'),
   join(evidence,'2026-10-05/operating-source-cold-material-incidence.json'),waterReceipt,
   join(evidence,'2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json')],
  artifacts=await Promise.all(paths.map(path=>readFile(path,'utf8'))),
  attainedText=await readFile(attainedReceipt,'utf8'),
  attained=z.object({nativeExit:z.literal(0),inspectionError:z.null(),frame:z.object({clusterIds:z.array(z.object({id:z.string()}))}),
   result:z.object({status:z.literal('PASS'),normal:z.object({samples:z.array(z.object({time_s:finite,
    motion:z.array(z.tuple([finite,finite,finite,finite,finite]))})).min(2)})})}).parse(JSON.parse(attainedText)),
  checkpoint=attained.result.normal.samples.at(-1)!
 if(plan.motion.clusters.some((c,i)=>c.id!==attained.frame.clusterIds[i]?.id)
  ||attained.frame.clusterIds.length!==plan.motion.clusters.length||checkpoint.motion.length!==plan.motion.clusters.length)
  throw Error('Full cooling/attained control identities differ')
 const original:ControlSourcePose[]=plan.motion.clusters.map(c=>({clusterId:c.id,body_y_m:0,stem_y_m:0,
   side:'increasing',stem_side:'increasing',contact:'seated'})),
  actual=original.map((p,i):ControlSourcePose=>({...p,body_y_m:checkpoint.motion[i]![0],stem_y_m:checkpoint.motion[i]![2],
   contact:checkpoint.motion[i]![0]===0?'seated':'offseat'})),
  trial=original.map((p,i):ControlSourcePose=>({...p,body_y_m:.003+.00001*i,stem_y_m:.0034+.000005*i,contact:'offseat'})),
  zero=original.map(()=>({body:0,stem:0})),direction=original.map((_,i)=>({body:.3*Math.sin(i+1),stem:.2*Math.cos(i+1)})),
  velocity=original.map((_,i)=>({body:.008*Math.sin(i+1),stem:.006*Math.cos(i+1)})),
  velocityDirection=original.map((_,i)=>({body:.01*Math.cos(i+1),stem:.02*Math.sin(i+1)})),
  cases=[{name:'ORIGINAL seated',poses:original,direction:zero,velocity:zero,velocityDirection:zero},
   {name:'Actual attained mechanical checkpoint (not a coupled trajectory)',poses:actual,direction:zero,velocity:zero,velocityDirection:zero},
   {name:'Nonuniform current-pose/rate trial',poses:trial,direction,velocity,velocityDirection},
   {name:'Restore ORIGINAL seated',poses:original,direction:zero,velocity:zero,velocityDirection:zero}],
  fields:(number|string)[]=[],frame=(s:string)=>{const words=s.trim().split(/\s+/);fields.push(words.length,...words)}
 frame(remapped.fixture);frame(nativeControlSourcePlan(plan).join('\n'))
 fields.push(remapped.passive.length,...remapped.passive.flatMap(q=>[q.stock,q.region,q.volume]),
  remapped.cylinder.length,...remapped.cylinder.flatMap(q=>[q.target,q.region,q.share]),
  plan.lower,plan.upper,plan.bottom,plan.top,plan.d.handling.guideInnerDiameter_m/2,plan.d.control.bodyDiameter_m/2,
  plan.d.control.rodletsPerCluster,plan.d.control.guideRoughness_m,plan.d.control.endLossEach,
  plan.guideBindings.length,...plan.guideBindings.flatMap(q=>[q.cluster,q.cell,q.lowerEdge,q.upperEdge]),cases.length)
 for(const c of cases)fields.push(...c.poses.flatMap(q=>[q.body_y_m,q.stem_y_m,q.side==='increasing'?1:0,
  q.stem_side==='increasing'?1:0,q.contact==='seated'?1:0]),...c.direction.flatMap(q=>[q.body,q.stem]),
  ...c.velocity.flatMap(q=>[q.body,q.stem]),...c.velocityDirection.flatMap(q=>[q.body,q.stem]))
 return {fixture:fields.join('\n')+'\n',ownerIdentities:[...new Map([
  ...sourceEvolutionOwnerFiles.map((name,i)=>[name,{name,sha256:sha(ownerText[i]!)}] as const),
  ...p.ownerIdentities.map(q=>[q.name,q] as const)]).values()],
  artifacts:paths.map((path,i)=>({path,sha256:sha(artifacts[i]!)})),
  attainedReceipt:{path:attainedReceipt,sha256:sha(attainedText)},cases:cases.map(q=>q.name),
  directionalCases:cases.flatMap((q,i)=>q.direction.some(d=>d.body!==0||d.stem!==0)||q.velocityDirection.some(d=>d.body!==0||d.stem!==0)?[i]:[]),
  mapping:prepared.mapping,counts:{originalWaterOwners:p.network.water.length,currentWaterOwners:plan.water.length,
   hydraulicEdges:plan.hydraulic.length,controlClusters:plan.motion.clusters.length,passiveRows:plan.passiveRows.length,
   cylinderRows:plan.cylinderRows.length,contacts:plan.contactPlans.length,mobileRoutes:plan.routes.length},
  sourceHistoryAdvanced:false,trajectoryAdmitted:false,liveModelInstalled:false,
  scope:'Full PRHR SOURCE/cooling model, one prepared native current geometry, same-stage residual/JVP/hydraulic consistency and reciprocal work. BODY source incidence only; no stem/spider neutron closure, full mechanical advancement or live installation.'}
}

if(import.meta.main){
 const [wiki,evidence,water,attained,binary,output,budget,...extra]=Bun.argv.slice(2),allowance=Number(budget)
 if(!wiki||!evidence||!water||!attained||!binary||!output||extra.length||!(allowance>0&&allowance<=180))
  throw Error('Usage: control-cooling-stage <LD01 wiki> <evidence root> <current ORIGINAL water receipt> <attained motion receipt> <native binary> <NEW receipt.json> <wall allowance <=180s>')
 const target=resolve(output),inputPath=target+'.input',directory=target+'.artifacts'
 await refuseOverwrite(target);await refuseOverwrite(inputPath);await mkdir(directory)
 const start=performance.now(),[nativeSourceIdentities,compilerIdentities,binarySha256]=await Promise.all([
  controlSourceNativeIdentities(),helperIdentities(import.meta.path),Bun.file(resolve(binary)).bytes().then(sha)]),
  prepared=await prepareControlCoolingStage(resolve(wiki),resolve(evidence),resolve(water),resolve(attained)),
  inspect=async()=>{
   try{
    if(binarySha256!==sha(await Bun.file(resolve(binary)).bytes()))return 'Native binary changed'
    if(JSON.stringify(nativeSourceIdentities)!==JSON.stringify(await controlSourceNativeIdentities()))return 'Native sources changed'
    if(JSON.stringify(compilerIdentities)!==JSON.stringify(await helperIdentities(import.meta.path)))return 'Compiler helpers changed'
    for(const q of prepared.ownerIdentities)if(q.sha256!==sha(await Bun.file(join(resolve(wiki),q.name)).bytes()))return 'Wiki owner changed '+q.name
    return null
   }catch(e){return 'Input inspection failed: '+String(e)}
  }
 await writeFile(inputPath,prepared.fixture,{flag:'wx'})
 let inspectionError=await inspect(),stdout='',stderr='',nativeExit:number|null=null,result:unknown=null
 const remaining=allowance-(performance.now()-start)/1000
 if(remaining<=1)inspectionError=inspectionError??'No remaining native evaluation allowance'
 if(!inspectionError){
  const child=Bun.spawn([resolve(binary),String(remaining-1),directory],{stdin:Buffer.from(prepared.fixture),stdout:'pipe',stderr:'pipe'}),
   timer=setTimeout(()=>child.kill(),remaining*1000)
  try{[stdout,stderr,nativeExit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])}
  finally{clearTimeout(timer)}
 }
 try{if(stdout.trim())result=JSON.parse(stdout)
  if(nativeExit===0)parseControlCoolingStageResult(result,{waterOwners:prepared.counts.currentWaterOwners,
   clusters:prepared.counts.controlClusters,cases:prepared.cases.length,directionalCases:prepared.directionalCases})
 }catch(e){inspectionError=String(e)}
 const guard=await inspect();if(guard)inspectionError=[inspectionError,guard].filter(Boolean).join('; ')
 let nativeArtifactIdentities:{path:string,sha256:string}[]=[]
 try{nativeArtifactIdentities=await Promise.all((await Array.fromAsync(new Bun.Glob('**/*').scan({cwd:directory,onlyFiles:true})))
  .sort().map(async path=>({path:join(directory,path),sha256:sha(await Bun.file(join(directory,path)).bytes())})))}
 catch(e){inspectionError=[inspectionError,'Native artifact inspection failed: '+String(e)].filter(Boolean).join('; ')}
 const elapsedSeconds=(performance.now()-start)/1000,{fixture,...metadata}=prepared,
  receipt={...metadata,inputPath,inputSha256:sha(fixture),nativeSourceIdentities,compilerIdentities,
   nativeBinaryPath:resolve(binary),binarySha256,elapsedSeconds,nativeExit,nativeStderr:stderr,result,inspectionError,nativeArtifactIdentities,
   ...(result===null?{nativeStdout:stdout}:{})}
 await writeFile(target,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 if(nativeExit!==0||inspectionError||elapsedSeconds>allowance)throw Error('Composed current-stage qualification failed; retained '+target)
 console.log(JSON.stringify({receipt:target,elapsedSeconds,counts:prepared.counts,result}))
}
