/** Bun compiles owned SI/geometry/original inputs; Rust owns fuel rate equations.
 * Qualification input is not a complete reactor operator or live plant. */
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import {sourceRegionSchema} from './reference-design-source-partition'
import {compileDecayHistory,parseDecayHistory} from './reference-design-decay-history'
import {configurationBlock,parseConfigurationMaterial} from './reference-design-source-laws'

const positive=z.number().finite().positive()
const freshSchema=z.object({u235HeavyMassFraction:z.number().finite().positive().lt(1),u235MolarMass_kg_mol:positive,
 u238MolarMass_kg_mol:positive,oxygenMolarMass_kg_mol:positive}).strict()
export function parseConfigurationFuel(document:string){
 const material=parseConfigurationMaterial(document),kinetics=material.kinetics,
  //This component consumes ONLY the freshFuel field; it does not validate or
  //silently reinterpret the other constituent owners as current coefficients.
  freshFuel=freshSchema.parse(configurationBlock(document,'reference-configuration-added-material').freshFuel),
  chiSum=material.fuel.chi.reduce((a,b)=>a+b,0)
 return {law:{absorption:material.fuel.absorption,fission:material.fuel.fission,
  scatter:material.fuel.scatter,nu:material.fuel.nu,chi:material.fuel.chi.map(x=>x/chiSum),
  speed:material.speed,
  beta:kinetics.delayedFractions,decay:kinetics.halfLives_s.map(t=>Math.LN2/t),f_d:kinetics.fD},
  originalChiSum:chiSum,freshFuel,kinetics}
}
const materialInputSchema=z.object({partitionIdentitySHA256:z.string().regex(/^[a-f0-9]{64}$/),
 result:z.object({preparation:z.literal('ORIGINAL fresh seated cold300K'),
  segments:z.array(z.object({id:z.string(),referenceFuelMass_kg:positive})),
  cohorts:z.array(z.object({id:z.string(),segmentId:z.string(),material:z.enum(['fuel','clad']),referenceMass_kg:positive,
   original_K:z.literal(300),mu:positive.optional()})),
  fissionIncidence:z.array(z.object({segmentId:z.string(),sourceRegionId:z.string(),compositeVolume_m3:positive,delayedBirthShare:positive})),
  heatIncidence:z.array(z.object({cohortId:z.string(),segmentId:z.string(),sourceRegionId:z.string(),W_kg:positive,eta:positive})),
 })})
const partitionSchema=z.object({result:z.object({regions:z.array(sourceRegionSchema)})})
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
export function compileFuelInputs(partitionReceipt:unknown,materialReceipt:unknown,record:ReturnType<typeof parseConfigurationFuel>,promptJ:number){
 const p=partitionSchema.parse(partitionReceipt),m=materialInputSchema.parse(materialReceipt),
  //Hash actual complete parent result, not the deliberately selected schema view.
  original=(partitionReceipt as {result:unknown}).result
 if(sha(JSON.stringify(original))!==m.partitionIdentitySHA256)throw Error('Cold material/source partition lineage mismatch')
 if(!Number.isFinite(promptJ)||promptJ<=0)throw Error('Missing actual originating-fuel prompt event charge')
 const regions=p.result.regions,segments=m.result.segments,cohorts=m.result.cohorts.filter(q=>q.material==='fuel'),
  unique=(ids:string[])=>{if(new Set(ids).size!==ids.length)throw Error('Duplicated physical coordinate identity')},
  index=(ids:string[])=>new Map(ids.map((id,i)=>[id,i]))
 unique(regions.map(r=>r.id));unique(segments.map(s=>s.id));unique(cohorts.map(q=>q.id))
 const ri=index(regions.map(r=>r.id)),si=index(segments.map(s=>s.id)),qi=index(cohorts.map(q=>q.id)),
  find=(map:Map<string,number>,id:string)=>{const i=map.get(id);if(i===undefined)throw Error('Missing physical incidence '+id);return i},
  mass=cohorts.map(q=>({segment:find(si,q.segmentId),mass:q.referenceMass_kg,mu:q.mu!})),
  volumes=segments.map(()=>0),weights=new Map<string,{cohort:number,mass:number}[]>()
 if(mass.some(q=>!Number.isFinite(q.mu)||q.mu<=0))throw Error('Missing once-only delayed material share')
 for(let s=0;s<segments.length;s++){
  const total=mass.filter(q=>q.segment===s).reduce((sum,q)=>sum+q.mass,0)
  if(Math.abs(total-segments[s]!.referenceFuelMass_kg)>2e-11*segments[s]!.referenceFuelMass_kg)
   throw Error('Original fuel stock/reference thermal mass mismatch')
 }
 for(const w of m.result.heatIncidence){
  const segment=find(si,w.segmentId),cohort=find(qi,w.cohortId);find(ri,w.sourceRegionId)
  if(mass[cohort]!.segment!==segment)throw Error('Heat cohort/material segment disagreement')
  const key=w.segmentId+'|'+w.sourceRegionId,list=weights.get(key)??[]
  list.push({cohort,mass:w.W_kg});weights.set(key,list)
 }
 for(const w of m.result.heatIncidence){const total=weights.get(w.segmentId+'|'+w.sourceRegionId)!.reduce((s,q)=>s+q.mass,0)
  if(Math.abs(w.eta-w.W_kg/total)>2e-11*Math.max(w.eta,w.W_kg/total))throw Error('Supplied prompt eta disagrees with actual W')}
 const used=new Set<string>()
 const intersections=m.result.fissionIncidence.map(e=>{
  const segment=find(si,e.segmentId),region=find(ri,e.sourceRegionId),key=e.segmentId+'|'+e.sourceRegionId,
   thermal=weights.get(key)
  if(!thermal?.length)throw Error('Missing actual regional thermal input')
  if(used.has(key))throw Error('Duplicated material/source intersection');used.add(key)
  volumes[segment]=volumes[segment]!+e.compositeVolume_m3
  return {region,segment,volume:e.compositeVolume_m3,weights:thermal}
 })
 if([...weights.keys()].some(key=>!used.has(key)))throw Error('Orphan thermal/source incidence')
 //The declared FULL segment is recovered from its immutable physical volume
 //share; a cropped set cannot be normalized by its represented volume.
 const full=segments.map(()=>undefined as number|undefined)
 for(const e of m.result.fissionIncidence){const s=find(si,e.segmentId),v=e.compositeVolume_m3/e.delayedBirthShare
  if(full[s]!==undefined&&Math.abs(v-full[s]!)>2e-11*v)throw Error('Inconsistent full physical segment volume');full[s]=v}
 if(full.some((v,s)=>v===undefined||Math.abs(v-volumes[s]!)>2e-11*v))throw Error('Missing composite coverage')
 const a=record.freshFuel,x=a.u235HeavyMassFraction,MU=1/(x/a.u235MolarMass_kg_mol+(1-x)/a.u238MolarMass_kg_mol),
  uraniumFraction=MU/(MU+2*a.oxygenMolarMass_kg_mol),NA=6.02214076e23,
  stocks=segments.map(s=>{const heavy=s.referenceFuelMass_kg*uraniumFraction,
   reserve=heavy*x/a.u235MolarMass_kg_mol*NA,fertile=heavy*(1-x)/a.u238MolarMass_kg_mol*NA
   return {reserve,reference_reserve:reserve,fertile,reference_fertile:fertile}})
 return {component:'regional induced-fuel reactions and six material precursors',completeReactorOperator:false,
  missingPhysicalContributions:['actual native moderator/mobile and retained absorber','guide/barrel/apparatus/other solid reactions',
   'body/panel/gate/converter optical target capture','regional transport and outer escape','Xe/Sm and installed/intrinsic/spontaneous births'],
  law:record.law,regionVolumes:regions.map(r=>r.volume_m3),segmentVolumes:full as number[],cohorts:mass,intersections,stocks,
  originalTemperature_K:cohorts.map(q=>q.original_K),promptJ_per_fission:promptJ,
  identities:{regions:regions.map(r=>r.id),segments:segments.map(s=>s.id),cohorts:cohorts.map(q=>q.id)},
  counts:{regions:regions.length,segments:segments.length,fuelCohorts:cohorts.length,intersections:intersections.length,
   neutronCoordinates:7*regions.length,precursorCoordinates:6*segments.length},originalChiSum:record.originalChiSum}
}
/** Qualification-only whitespace fixture, not a product wire/schema. Exact
 * source code reads this finite record without serde or a second crate. */
export function nativeFuelFixture(r:ReturnType<typeof compileFuelInputs>){
 const chunks:(number|string)[]=[r.regionVolumes.length,r.segmentVolumes.length,r.cohorts.length,r.intersections.length],
  law=r.law
 chunks.push(...law.absorption,...law.fission,...law.scatter.flat(),...law.nu,...law.chi,...law.speed,...law.beta,...law.decay,law.f_d,
  ...r.regionVolumes,...r.segmentVolumes)
 for(const c of r.cohorts)chunks.push(c.segment,c.mass,c.mu)
 for(const e of r.intersections){chunks.push(e.region,e.segment,e.volume,e.weights.length);for(const w of e.weights)chunks.push(w.cohort,w.mass)}
 for(const s of r.stocks)chunks.push(s.reserve,s.reference_reserve,s.fertile,s.reference_fertile)
 chunks.push(...r.originalTemperature_K,r.promptJ_per_fission)
 return chunks.join('\n')+'\n'
}
export async function qualifyFuelInputs(partitionPath:string,materialPath:string,ownerPath:string,heatOwnerPath:string,output:string){
 const began=performance.now()
 try{await readFile(output);throw Error('Receipt exists; refusing overwrite')}
 catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error}
 const paths=[partitionPath,materialPath,ownerPath,heatOwnerPath].map(p=>resolve(p)),texts=await Promise.all(paths.map(p=>Bun.file(p).text())),
  record=parseConfigurationFuel(texts[2]!),prompt=compileDecayHistory(parseDecayHistory(texts[3]!)).promptFissionEnergy_J,
  input=compileFuelInputs(JSON.parse(texts[0]!),JSON.parse(texts[1]!),record,prompt),
  root=resolve(import.meta.dir,'../native/process-plant'),sourceFiles=[import.meta.path,resolve(import.meta.dir,'reference-design-source-laws.ts'),resolve(import.meta.dir,'reference-design-decay-history.ts'),
   join(root,'src/fuel_source.rs'),join(root,'qualification/fuel-source.rs'),join(root,'src/lib.rs'),resolve(import.meta.dir,'reference-design-source-partition.ts')],
  sources=await Promise.all(sourceFiles.map(p=>Bun.file(p).text())),scratch=await mkdtemp(join(tmpdir(),'ld01-rust-fuel-')),
  fixture=nativeFuelFixture(input),fixturePath=join(scratch,'input.txt'),binary=join(scratch,'fuel-source')
 //Keep the exact qualification input/source beside the immutable receipt. The
 //large immutable parent receipts remain referenced by path/hash, not copied.
 const artifactDirectory=resolve(output)+'.artifacts',retainedFixture=join(artifactDirectory,'input.txt'),
  retainedSources=sourceFiles.map(path=>join(artifactDirectory,basename(path)))
 await mkdir(artifactDirectory)
 await writeFile(retainedFixture,fixture,{flag:'wx'})
 await Promise.all(retainedSources.map((path,i)=>writeFile(path,sources[i]!,{flag:'wx'})))
 await writeFile(fixturePath,fixture,{flag:'wx'})
 async function execute(command:string[]){const remaining=60_000-(performance.now()-began)
  if(remaining<=0)return {command,exitCode:null,stdout:'',stderr:'Aggregate allowance exhausted',timedOut:true}
  const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},remaining)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,stdout,stderr,exitCode,timedOut}
 }
 const toolchain=await execute(['rustc','--version']),
  compile=toolchain.exitCode===0&&!toolchain.timedOut
   ?await execute(['rustc','--edition=2024','-C','opt-level=2',join(root,'qualification/fuel-source.rs'),'-o',binary]):undefined,
  run=compile?.exitCode===0&&!compile.timedOut?await execute([binary,fixturePath]):undefined,
  binaryBytes=compile?.exitCode===0&&!compile.timedOut?await readFile(binary):undefined,
  binarySHA256=binaryBytes?createHash('sha256').update(binaryBytes).digest('hex'):undefined,
  retainedBinary=binaryBytes?join(artifactDirectory,'fuel-source'):undefined
 if(binaryBytes&&retainedBinary)await writeFile(retainedBinary,binaryBytes,{flag:'wx'})
 const
  unchanged=(await Promise.all(sourceFiles.map(p=>Bun.file(p).text()))).every((s,i)=>s===sources[i])
   &&(await Promise.all(paths.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i]),
  result={passed:toolchain.exitCode===0&&!toolchain.timedOut&&compile?.exitCode===0&&!compile.timedOut
    &&run?.exitCode===0&&!run.timedOut&&unchanged&&(performance.now()-began)<=60_000,
   allowanceSeconds:60,elapsedSeconds:(performance.now()-began)/1000,input,consumed:paths.map((path,i)=>({path,sha256:sha(texts[i]!)})),
   sources:sourceFiles.map((path,i)=>({path,sha256:sha(sources[i]!)})),fixtureSHA256:sha(fixture),scratch,toolchain,binarySHA256,compile,run,unchanged,
   artifacts:{directory:artifactDirectory,fixture:retainedFixture,sources:retainedSources,binary:retainedBinary},
   scope:'Rust fuel contribution, local analytic coefficient/event sensitivities and conservative heat incidence at finite qualification snapshots only. No neutron time trajectory, current nonfuel operator, calibration, startup/trip or real-time performance.'}
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result
}
if(import.meta.main){
 const [partition,material,owner,heat,output]=Bun.argv.slice(2)
 if(!partition||!material||!owner||!heat||!output)throw Error('Expected partition receipt, cold material receipt, configuration owner, heat owner and NEW result')
  const result=await qualifyFuelInputs(partition,material,owner,heat,output)
 console.log(JSON.stringify({passed:result.passed,counts:result.input.counts,elapsedSeconds:result.elapsedSeconds,result:result.run?.stdout,output}))
 if(!result.passed)process.exitCode=1
}
