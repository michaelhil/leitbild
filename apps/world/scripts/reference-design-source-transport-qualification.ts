/** One bounded nonadvancing composed check. The omitted material/optical/birth
 * inputs remain missing; a finite algebra probe is not an ORIGINAL trajectory. */
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import {compileFuelInputs,nativeFuelFixture,parseConfigurationFuel} from './reference-design-source-fuel'
import {compileModeratorInputs,nativeModeratorFixture,parseConfigurationModerator} from './reference-design-source-moderator'
import {compileDecayHistory,parseDecayHistory} from './reference-design-decay-history'
import {compileSourceFaces} from './reference-design-source-faces'
import {sourceRegionSchema} from './reference-design-source-partition'
import {parseTransferGates} from './reference-design-fuel-transfer'
import {partialTransparentTransportGeometry} from './reference-design-source-transport'

const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex'),
 finite=z.number().finite(),positive=finite.positive(),
 partitionSchema=z.object({result:z.object({regions:z.array(sourceRegionSchema),corePlenumInterfaceArea_m2:positive,
  headArea_m2:positive,panelSupport_m:z.object({bottom:finite,top:finite}).strict()})})

export function compilePartialSourceCheck(partitionText:string,materialText:string,waterText:string,
 ownerText:string,heatText:string,gateText:string){
 const partition=JSON.parse(partitionText),f=compileFuelInputs(partition,JSON.parse(materialText),parseConfigurationFuel(ownerText),
   compileDecayHistory(parseDecayHistory(heatText)).promptFissionEnergy_J),
  m=compileModeratorInputs(partition,JSON.parse(waterText),parseConfigurationModerator(ownerText)),
  p=partitionSchema.parse(partition),faceResult=compileSourceFaces(p.result,parseTransferGates(gateText),[0,0]),
  faceReceipt=JSON.stringify({partitionSHA256:sha(partitionText),result:faceResult}),
  t=partialTransparentTransportGeometry(partitionText,faceReceipt,f.law.speed)
 if(f.identities.regions.some((id,i)=>id!==m.identities.regions[i])||f.regionVolumes.length!==m.regionVolumes.length
  ||f.law.speed.some((v,g)=>v!==m.law.speed[g]))throw Error('Inconsistent composed material/transport coordinates')
 // ORIGINAL fresh/cold coefficients of these TWO present contributors only.
 // Missing receiving solids/water etc are not guessed from gross free volume.
 const collision=t.regionVolumes.map(()=>Array(7).fill(0) as number[])
 for(const e of f.intersections)for(let g=0;g<7;g++)collision[e.region]![g]!+=e.volume/f.regionVolumes[e.region]!
  *(f.law.absorption[g]!+f.law.scatter[g]!.reduce((a,b)=>a+b,0))
 for(let i=0;i<m.intersections.length;i++){
  const e=m.intersections[i]!,s=m.stocks[i]!,V=m.regionVolumes[e.region]!,fill=s.water_mass/(m.law.reference_density*V),
   H=s.hydrogen_target/(s.hydrogen_target+s.hydrogen_product)
  for(let g=0;g<7;g++)collision[e.region]![g]!+=fill*(m.law.absorption[g]!*H+m.law.scatter[g]!.reduce((a,b)=>a+b,0))
   +m.law.boron_sigma[g]!*s.mobile_boron10/V
 }
 if(collision.flat().some(v=>!Number.isFinite(v)||v<0))throw Error('Nonfinite/negative partial material collision')
 const ff=nativeFuelFixture(f).trim().split(/\s+/),mf=nativeModeratorFixture(m).trim().split(/\s+/),
  fields:(string|number)[]=[ff.length,...ff,mf.length,...mf,t.regionVolumes.length,t.faces.length,
   ...t.speed,...t.regionVolumes,...t.envelopeLengths]
 for(const face of t.faces)fields.push(face.left,face.right??-1,face.area,face.left_distance,face.right_distance??0)
 fields.push(...collision.flat())
 return {fixture:fields.join('\n')+'\n',faceReceipt,input:{completeReactorOperator:false,advancedSeconds:0,
  probe:'Artificial finite and signed N/C algebra trials, not actual original inventories or evolution',
  counts:{regions:t.regionVolumes.length,fuelSegments:f.counts.segments,fuelCohorts:f.counts.fuelCohorts,
   primaryWaterIntersections:m.counts.intersections,transparentFaces:t.faces.filter(q=>q.right!==undefined).length,
   escapeFaces:t.faces.filter(q=>q.right===undefined).length,omittedFaces:t.omittedFaces.length,
   regionsWithNoPresentCollision:collision.filter(gs=>gs.every(v=>v===0)).length},
  omittedFaces:t.omittedFaces,omittedArea_m2:t.omittedArea_m2,
  missingPhysicalContributions:['covered head/rack/gate material attenuation and capture',
   'receiving water, nonfuel solids and finite body/converter/retained absorber response',
   'Xe/Sm and physical external/intrinsic/spontaneous births',
   'complete photon/charged deposition and joined finite thermal recipients'],
  collisionScope:'Present fresh-cold fuel and PRIMARY native water/mobile B10 contributions only. Zero does NOT identify physical vacuum.',
  geometryScope:'Initial comparator graph; inherited physical compartment envelope lengths, not child mesh spans.',
  emissionIsDepositedHeat:false}}
}

export async function qualifyPartialSourceCheck(paths:string[],output:string){
 const began=performance.now(),allowanceMs=60_000
 if(paths.length!==6)throw Error('Expected partition, material, qualified water, source owner, heat owner, gate owner')
 try{await readFile(output);throw Error('Receipt exists; refusing overwrite')}
 catch(e){if(!(e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT'))throw e}
 const consumed=paths.map(p=>resolve(p)),texts=await Promise.all(consumed.map(p=>Bun.file(p).text())),
  prepared=compilePartialSourceCheck(texts[0]!,texts[1]!,texts[2]!,texts[3]!,texts[4]!,texts[5]!),
  root=resolve(import.meta.dir,'../native/process-plant'),
  sourcePaths=[import.meta.path,...['source-transport','source-fuel','source-moderator','source-laws','source-faces',
   'source-partition','fuel-transfer','decay-history'].map(s=>resolve(import.meta.dir,'reference-design-'+s+'.ts')),
   ...['fuel_source','moderator_source','transport_source'].map(s=>join(root,'src',s+'.rs')),join(root,'qualification/source-transport.rs')],
  sources=await Promise.all(sourcePaths.map(p=>Bun.file(p).text())),scratch=await mkdtemp(join(tmpdir(),'ld01-source-transport-')),
  artifactDirectory=resolve(output)+'.artifacts',fixturePath=join(artifactDirectory,'input.txt'),binary=join(scratch,'source-transport')
 await mkdir(artifactDirectory)
 await writeFile(fixturePath,prepared.fixture,{flag:'wx'});await writeFile(join(artifactDirectory,'faces.json'),prepared.faceReceipt,{flag:'wx'})
 await Promise.all(sourcePaths.map((p,i)=>writeFile(join(artifactDirectory,basename(p)),sources[i]!,{flag:'wx'})))
 async function execute(command:string[]){
  const remaining=allowanceMs-(performance.now()-began)
  if(remaining<=0)return {command,exitCode:null,stdout:'',stderr:'Aggregate allowance exhausted',timedOut:true}
  const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},remaining)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,exitCode,stdout,stderr,timedOut}
 }
 const version=await execute(['rustc','--version']),compile=version.exitCode===0&&!version.timedOut
  ?await execute(['rustc','--edition=2024','-C','opt-level=2',join(root,'qualification/source-transport.rs'),'-o',binary]):undefined,
  run=compile?.exitCode===0&&!compile.timedOut?await execute([binary,fixturePath]):undefined,
  bytes=compile?.exitCode===0?await readFile(binary):undefined
 if(bytes)await writeFile(join(artifactDirectory,'source-transport'),bytes,{flag:'wx'})
 const unchanged=(await Promise.all(consumed.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i])
  &&(await Promise.all(sourcePaths.map(p=>Bun.file(p).text()))).every((s,i)=>s===sources[i]),elapsedSeconds=(performance.now()-began)/1000,
  result={passed:version.exitCode===0&&!version.timedOut&&compile?.exitCode===0&&!compile.timedOut
   &&run?.exitCode===0&&!run.timedOut&&unchanged&&elapsedSeconds<=allowanceMs/1000,
   allowanceSeconds:allowanceMs/1000,elapsedSeconds,input:prepared.input,
   consumed:consumed.map((path,i)=>({path,sha256:sha(texts[i]!)})),sources:sourcePaths.map((path,i)=>({path,sha256:sha(sources[i]!)})),
   fixtureSHA256:sha(prepared.fixture),binarySHA256:bytes?sha(bytes):undefined,version,compile,run,unchanged,
   artifacts:{directory:artifactDirectory},scope:'Nonadvancing additive partial source composition. No full source field, solver advancement, thermal deposition, physical calibration or reactor performance claim.'}
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result
}
if(import.meta.main){
 const args=Bun.argv.slice(2),output=args[6]
 if(args.length!==7||!output)throw Error('Expected partition, material, qualified water, source owner, heat owner, gate owner, NEW receipt')
 const r=await qualifyPartialSourceCheck(args.slice(0,6),output)
 console.log(JSON.stringify({passed:r.passed,elapsedSeconds:r.elapsedSeconds,input:r.input.counts,result:r.run?.stdout,output}))
 if(!r.passed)process.exitCode=1
}
