/** Compile the actual PRIMARY source water receipt into the reusable Rust
 * moderator/mobile-B10 contribution. No full reactor or live plant installation. */
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import {configurationBlock,parseConfigurationMaterial} from './reference-design-source-laws'
import {sourceRegionSchema} from './reference-design-source-partition'
const positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative()
const responseSchema=z.object({referenceDensity_kg_m3:positive,
 boron10:z.object({referenceCrossSection_barn:positive,referenceEnergy_eV:positive,
  captureGroups:z.array(z.number().int().min(1).max(7)).min(1).refine(a=>new Set(a).size===a.length,'Repeated capture group')}).strict(),
 captureEmission_MeV:z.object({water:z.object({charged:nonnegative,photon:nonnegative}).strict(),
  boron10:z.object({charged:nonnegative,photon:nonnegative}).strict()}).strict()}).strict()
export function parseConfigurationModerator(document:string){
 const material=parseConfigurationMaterial(document),response=responseSchema.parse(configurationBlock(document,'reference-configuration-water-response')),
  J=(value:number)=>value*1.602176634e-13
 return {law:{absorption:material.water.absorption,scatter:material.water.scatter,speed:material.speed,
  boron_sigma:material.kinetics.energies_eV.map((E,g)=>response.boron10.captureGroups.includes(g+1)
   ?response.boron10.referenceCrossSection_barn*1e-28*Math.sqrt(response.boron10.referenceEnergy_eV/E):0),
  reference_density:response.referenceDensity_kg_m3,
  hydrogen_emission:[J(response.captureEmission_MeV.water.charged),J(response.captureEmission_MeV.water.photon)],
  boron_emission:[J(response.captureEmission_MeV.boron10.charged),J(response.captureEmission_MeV.boron10.photon)]},response}
}
const amount=z.object({volume_m3:nonnegative,water_kg:nonnegative,Htarget:nonnegative,HcaptureProduct:nonnegative,mobileN10:nonnegative})
const waterSchema=z.object({passed:z.literal(true),partitionSHA256:z.string().regex(/^[a-f0-9]{64}$/),
 result:z.object({preparation:z.literal('ORIGINAL cold2000 IF97 primary source support'),
  sourceIncidence:z.array(z.object({owner:z.string().min(1),sourceRegionId:z.string().min(1),amount})),
  nativeOwners:z.array(z.object({owner:z.string().min(1),represented:amount}))})})
const partitionSchema=z.object({result:z.object({regions:z.array(sourceRegionSchema)})})
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
export function compileModeratorInputs(partitionReceipt:unknown,waterReceipt:unknown,record:ReturnType<typeof parseConfigurationModerator>){
 const partition=partitionSchema.parse(partitionReceipt),water=waterSchema.parse(waterReceipt)
 if(sha(JSON.stringify((partitionReceipt as {result:unknown}).result))!==water.partitionSHA256)throw Error('Native water/source partition lineage mismatch')
 const regions=partition.result.regions,indices=new Map(regions.map((r,i)=>[r.id,i])),
  owners=new Map(water.result.nativeOwners.map(o=>[o.owner,o])),seen=new Set<string>(),
  keys=['volume_m3','water_kg','Htarget','HcaptureProduct','mobileN10'] as const,
  sums=new Map(water.result.nativeOwners.map(o=>[o.owner,Object.fromEntries(keys.map(k=>[k,0])) as Record<typeof keys[number],number>])),
  covered=new Float64Array(regions.length)
 if(indices.size!==regions.length||owners.size!==water.result.nativeOwners.length)throw Error('Duplicated region/native owner identity')
 const intersections=water.result.sourceIncidence.map(row=>{
  const region=indices.get(row.sourceRegionId),key=row.owner+'|'+row.sourceRegionId
  if(region===undefined||!owners.has(row.owner)||seen.has(key)||row.amount.volume_m3<=0||row.amount.water_kg<=0||row.amount.Htarget<=0)
   throw Error('Invalid/duplicated original native water incidence')
  seen.add(key)
  covered[region]=covered[region]!+row.amount.volume_m3
  for(const k of keys)sums.get(row.owner)![k]+=row.amount[k]
  return {region,volume:row.amount.volume_m3}
 }),stocks=water.result.sourceIncidence.map(row=>({water_mass:row.amount.water_kg,liquid_volume:row.amount.volume_m3,
  hydrogen_target:row.amount.Htarget,hydrogen_product:row.amount.HcaptureProduct,mobile_boron10:row.amount.mobileN10}))
 // The selected cold300K IF97 parent is entirely liquid. This is not a phase
 // guess for reached state: reached consumers must supply their actual liquid.
 for(const owner of owners.values())for(const key of keys){
  const actual=sums.get(owner.owner)![key],expected=owner.represented[key]
  if(Math.abs(actual-expected)>3e-11*Math.max(actual,expected,1e-18))throw Error('Missing/duplicated represented native stock '+owner.owner+' '+key)
 }
 for(let r=0;r<regions.length;r++)if(covered[r]!>regions[r]!.volume_m3*(1+3e-11))
  throw Error('Primary water support exceeds source region')
 return {component:'PRIMARY H2O moderator and MOBILE liquid B10 reactions',completeReactorOperator:false,
  missingPhysicalContributions:['receiving bay/native water','retained/body/panel/gate/converter absorber and other solid reactions',
   'regional transport and outer escape','poison/external births and complete source calibration','capture photon/charged recipient incidence'],
  law:record.law,regionVolumes:regions.map(r=>r.volume_m3),intersections,stocks,
  identities:{regions:regions.map(r=>r.id),rows:water.result.sourceIncidence.map(r=>r.owner+'|'+r.sourceRegionId)},
  counts:{regions:regions.length,nativeOwners:owners.size,intersections:intersections.length,neutronCoordinates:7*regions.length},
  emissionIsDepositedHeat:false}
}
/** Qualification-only finite fixture; no product wire or second coefficient owner. */
export function nativeModeratorFixture(input:ReturnType<typeof compileModeratorInputs>){
 const law=input.law,chunks:number[]=[input.regionVolumes.length,input.intersections.length]
 chunks.push(...law.absorption,...law.scatter.flat(),...law.speed,...law.boron_sigma,law.reference_density,
  ...law.hydrogen_emission,...law.boron_emission,...input.regionVolumes)
 input.intersections.forEach((e,i)=>{const s=input.stocks[i]!
  chunks.push(e.region,e.volume,s.water_mass,s.liquid_volume,s.hydrogen_target,s.hydrogen_product,s.mobile_boron10)})
 return chunks.join('\n')+'\n'
}
export async function qualifyModeratorInputs(partitionPath:string,waterPath:string,ownerPath:string,output:string,allowanceMs=60_000){
 if(!Number.isFinite(allowanceMs)||allowanceMs<=0||allowanceMs>60_000)throw Error('Expected positive remaining allowance <=60000 ms')
 const began=performance.now()
 try{await readFile(output);throw Error('Receipt exists; refusing overwrite')}
 catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error}
 const paths=[partitionPath,waterPath,ownerPath].map(p=>resolve(p)),texts=await Promise.all(paths.map(p=>Bun.file(p).text())),
  input=compileModeratorInputs(JSON.parse(texts[0]!),JSON.parse(texts[1]!),parseConfigurationModerator(texts[2]!)),
  root=resolve(import.meta.dir,'../native/process-plant'),sourceFiles=[import.meta.path,resolve(import.meta.dir,'reference-design-source-laws.ts'),
   resolve(import.meta.dir,'reference-design-source-partition.ts'),join(root,'src/moderator_source.rs'),join(root,'qualification/moderator-source.rs')],
  sources=await Promise.all(sourceFiles.map(p=>Bun.file(p).text())),scratch=await mkdtemp(join(tmpdir(),'ld01-rust-moderator-')),
  fixture=nativeModeratorFixture(input),fixturePath=join(scratch,'input.txt'),binary=join(scratch,'moderator-source'),
  artifactDirectory=resolve(output)+'.artifacts',retainedSources=sourceFiles.map(p=>join(artifactDirectory,basename(p)))
 await mkdir(artifactDirectory)
 await writeFile(join(artifactDirectory,'input.txt'),fixture,{flag:'wx'})
 await Promise.all(retainedSources.map((p,i)=>writeFile(p,sources[i]!,{flag:'wx'})))
 await writeFile(fixturePath,fixture,{flag:'wx'})
 async function execute(command:string[]){
  const remaining=allowanceMs-(performance.now()-began)
  if(remaining<=0)return {command,exitCode:null,stdout:'',stderr:'Aggregate allowance exhausted',timedOut:true}
  const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},remaining)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,stdout,stderr,exitCode,timedOut}
 }
 const toolchain=await execute(['rustc','--version']),compile=toolchain.exitCode===0&&!toolchain.timedOut
  ?await execute(['rustc','--edition=2024','-C','opt-level=2',join(root,'qualification/moderator-source.rs'),'-o',binary]):undefined,
  run=compile?.exitCode===0&&!compile.timedOut?await execute([binary,fixturePath]):undefined,
  binaryBytes=compile?.exitCode===0&&!compile.timedOut?await readFile(binary):undefined,
  retainedBinary=binaryBytes?join(artifactDirectory,'moderator-source'):undefined
 if(binaryBytes&&retainedBinary)await writeFile(retainedBinary,binaryBytes,{flag:'wx'})
 const unchanged=(await Promise.all(sourceFiles.map(p=>Bun.file(p).text()))).every((s,i)=>s===sources[i])
  &&(await Promise.all(paths.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i]),
  result={passed:toolchain.exitCode===0&&!toolchain.timedOut&&compile?.exitCode===0&&!compile.timedOut&&run?.exitCode===0&&!run.timedOut
    &&unchanged&&performance.now()-began<=allowanceMs,allowanceSeconds:allowanceMs/1000,elapsedSeconds:(performance.now()-began)/1000,input,
   consumed:paths.map((path,i)=>({path,sha256:sha(texts[i]!)})),sources:sourceFiles.map((path,i)=>({path,sha256:sha(sources[i]!)})),
   fixtureSHA256:sha(fixture),binarySHA256:binaryBytes?sha(binaryBytes):undefined,toolchain,compile,run,unchanged,scratch,
   artifacts:{directory:artifactDirectory,sources:retainedSources,binary:retainedBinary},
   scope:'Actual PRIMARY native water input; finite-state moderator/mobile liquid B10 rates, analytic coefficient partials, events and binding emission only. No trajectory, retained absorber, photon deposition, full reactor, calibration or real-time claim.'}
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
 return result
}
if(import.meta.main){
 const [partition,water,owner,output,remainingMs]=Bun.argv.slice(2)
 if(!partition||!water||!owner||!output)throw Error('Expected partition receipt, qualified original-water receipt, source owner and NEW result')
 const result=await qualifyModeratorInputs(partition,water,owner,output,remainingMs===undefined?60_000:Number(remainingMs))
 console.log(JSON.stringify({passed:result.passed,counts:result.input.counts,elapsedSeconds:result.elapsedSeconds,result:result.run?.stdout,output}))
 if(!result.passed)process.exitCode=1
}
