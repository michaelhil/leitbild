/** Bounded direct compiler/native equality test. Preparation exports the SAME
 * immutable plan for connected advancement; there is no TS per-step callback. */
import {createHash} from 'node:crypto'
import {writeFile,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileSourceFaces} from './reference-design-source-faces'
import {compileOriginalPassiveGeometry,type MovingControlSteelSelection} from './reference-design-source-passive'
import {compileCylinderInputs} from './reference-design-source-cylinder'
import {parseNuclearObservation} from './reference-design-nuclear-observation'
import {compileControlSourceMotion,controlSourceMotionAt,nativeControlSourcePlan,nativeControlSourceStage,
 nativeMovingFuelCoolingFixture,parseControlSteelNuclear,type ControlSourcePose} from './reference-design-control-source-motion'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import type {ColdControlRelease} from './reference-design-control-release'

/** Fresh ORIGINAL preparation only. Native keeps all histories after this one
 * construction; this helper is never called at an attained stage/checkpoint. */
export async function prepareMovingFuelCooling(wiki:string,evidence:string,waterReceipt:string,selection:MovingControlSteelSelection={},releaseSelection?:ColdControlRelease){
 const [geometry,documents,partition,material,water,receiving]=await Promise.all([
  prepareNativeControlGeometry(wiki,selection,releaseSelection),
  Promise.all(sourceEvolutionOwnerFiles.map(async p=>[p,await readFile(join(wiki,p),'utf8')] as const)).then(a=>new Map(a)),
  readFile(join(evidence,'2026-10-05/operating-source-fixed-partition.json'),'utf8'),
  readFile(join(evidence,'2026-10-05/operating-source-cold-material-incidence.json'),'utf8'),readFile(waterReceipt,'utf8'),
  readFile(join(evidence,'2026-10-06/source-composed-cylinder-converter-1.json.artifacts/material.json'),'utf8')]),
  source=compileSourceEvolution(partition,material,water,documents,JSON.parse(receiving).receiving.property,selection),
  cooling=nativeMovingFuelCoolingFixture(geometry.plan,geometry.p,source)
 return {...geometry,source,cooling}
}

/** Single native wire owner for both current-stage and advancing compositions.
 * The caller appends only its experiment/command frame, never another plant. */
export function movingFuelCoolingNativeInput(p:Awaited<ReturnType<typeof prepareMovingFuelCooling>>){
 const {plan,cooling}=p,fields:(number|string)[]=[],frame=(s:string)=>{
  const words=s.trim().split(/\s+/);fields.push(words.length)
  for(const word of words)fields.push(word)
 }
 frame(cooling.fixture);frame(nativeControlSourcePlan(plan).join('\n'))
 fields.push(cooling.passive.length)
 for(const q of cooling.passive)fields.push(q.stock,q.region,q.volume)
 fields.push(cooling.cylinder.length)
 for(const q of cooling.cylinder)fields.push(q.target,q.region,q.share)
 fields.push(plan.lower,plan.upper,plan.bottom,plan.top,plan.d.handling.guideInnerDiameter_m/2,plan.d.control.bodyDiameter_m/2,
  plan.d.control.rodletsPerCluster,plan.d.control.guideRoughness_m,plan.d.control.endLossEach,
  plan.guideBindings.length)
 for(const q of plan.guideBindings)fields.push(q.cluster,q.cell,q.lowerEdge,q.upperEdge)
 return fields
}

export async function prepareNativeControlGeometry(wiki:string,selection:MovingControlSteelSelection={},releaseSelection?:ColdControlRelease){
 if(releaseSelection&&!selection.controlSteel)throw Error('Selected cold release requires the joined moving structural SOURCE material')
 const read=(path:string)=>readFile(join(wiki,path),'utf8'),p=await compileFuelCooling(wiki,{prhr:true}),
  d=parsePrimaryWaterInputs(await Promise.all(primaryWaterOwnerFiles.map(read))),
  text=await read('systems/reactor/configuration-source-and-history.md'),
  passive=compileOriginalPassiveGeometry(p.material.partition,d,p.material.result,
   compileSourceFaces(p.material.partition,d.gates,[0,0]).faces,text,selection),
  cylinder=compileCylinderInputs(p.material.partition,d,p.material.result,passive,
   parseNuclearObservation(await read('systems/instrumentation/nuclear-observation-apparatus.md')),text),
  plan=compileControlSourceMotion(d,p,passive,cylinder,selection.controlSteel?parseControlSteelNuclear(await read('systems/reactor/control-absorber-and-guide-water.md')):undefined,releaseSelection),original:ControlSourcePose[]=plan.motion.clusters.map(c=>({clusterId:c.id,
   body_y_m:0,stem_y_m:0,side:'increasing',stem_side:'increasing',contact:'seated'})),
  synthetic=original.map((p,i):ControlSourcePose=>({...p,body_y_m:.003+.00001*i,stem_y_m:.0034+.000005*i,contact:'offseat'})),
  direction=original.map((_,i)=>({body:.3*Math.sin(i+1),stem:.2*Math.cos(i+1)})),
  zero=original.map(()=>({body:0,stem:0})),h=.004,
  cases=[{name:'ORIGINAL seated',poses:original,direction:zero},
   {name:'Offseat right-limit selected by caller',poses:original.map(p=>({...p,contact:'offseat' as const})),direction:zero},
   {name:'Synthetic nonuniform unaccepted pose',poses:synthetic,direction},
   ...[1,-1].map(sign=>({name:(sign>0?'Positive':'Negative')+' selected-branch trial',
    poses:synthetic.map((p,i)=>({...p,body_y_m:p.body_y_m+sign*h*direction[i]!.body,stem_y_m:p.stem_y_m+sign*h*direction[i]!.stem})),direction})),
   {name:'Restore ORIGINAL seated',poses:original,direction:zero}],
  velocity=original.map((_,i)=>({body:.008*Math.sin(i+1),stem:.006*Math.cos(i+1)})),
  velocityDirection=original.map((_,i)=>({body:.01*Math.cos(i+1),stem:.02*Math.sin(i+1)})),
  planFields=nativeControlSourcePlan(plan),fields=[planFields.length,...planFields,cases.length]
 for(const c of cases){const stage=controlSourceMotionAt(plan,c.poses,c.direction)
  fields.push(...c.poses.flatMap(p=>[p.body_y_m,p.stem_y_m,p.side==='increasing'?1:0,p.stem_side==='increasing'?1:0,p.contact==='seated'?1:0]),
   ...c.direction.flatMap(d=>[d.body,d.stem]),...velocity.flatMap(d=>[d.body,d.stem]),...velocityDirection.flatMap(d=>[d.body,d.stem]),
   ...nativeControlSourceStage(stage),stage.barrelChords_m.length,...stage.barrelChords_m,stage.barrelChordDirection_m.length,...stage.barrelChordDirection_m)
 }
 return {plan,p,passive,cylinder,fixture:fields.join('\n')+'\n',cases:cases.map(c=>c.name),mapping:{
  originalWater:p.network.water.map((w,i)=>({id:w.id,original:i,current:plan.oldWaterToNew[i]})),
  water:plan.water.map((w,i)=>({id:w.id,index:i,volume_m3:w.volume_m3,firstMoment_m4:w.volume_m3*w.elevation_m,
   fixedEOSDatum_m:w.elevation_m})),lower:plan.lower,upper:plan.upper,guideBindings:plan.guideBindings}}
}
if(import.meta.main){
 const [wiki,binary,output,...extra]=Bun.argv.slice(2)
 if(!wiki||!binary||!output||extra.length)throw Error('Usage: bun reference-design-control-geometry.ts <wiki-LD01> <native-control-geometry-binary> <new-receipt>')
 const prepared=await prepareNativeControlGeometry(wiki),sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex'),
  binaryBytes=await Bun.file(binary).bytes(),inputPath=resolve(output)+'.input',
  child=Bun.spawn([resolve(binary)],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 await writeFile(inputPath,prepared.fixture,{flag:'wx'})
 child.stdin.write(prepared.fixture);child.stdin.end()
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]),
  result=stdout.trim()?JSON.parse(stdout):null,receipt={nativeBinaryPath:resolve(binary),nativeBinarySha256:sha(binaryBytes),
   inputPath,inputSha256:sha(prepared.fixture),exit,stderr,result,cases:prepared.cases,mapping:prepared.mapping,
   scope:'One prepared native evaluator, exact full PRHR47→98 mapping and direct TS/native current geometry+rate-direction comparison. No admitted plant trajectory.'}
 await writeFile(resolve(output),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({output:resolve(output),exit,result}))
 if(exit!==0||result?.pass!==true)process.exitCode=1
}
