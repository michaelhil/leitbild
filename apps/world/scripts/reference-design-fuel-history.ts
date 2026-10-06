/** Owned fuel-history assembly input, not a complete neutron solver or plant. */
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,join,resolve} from 'node:path'
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {compileFuelInputs,nativeFuelFixture,parseConfigurationFuel} from './reference-design-source-fuel'
import {compileDecayHistory,parseDecayHistory} from './reference-design-decay-history'
import {parseColdNuclear} from './reference-design-cold-nuclear'
import {parseFuelHandling} from './reference-design-fuel-handling'
import {parseNuclearObservation} from './reference-design-nuclear-observation'
import {diskRectangleArea,sourceRegionSchema} from './reference-design-source-partition'
import {coldSourceMaterialOwnerFiles,compileColdSourceMaterialOwners} from './reference-design-source-material'

const positive=z.number().finite().positive(),fraction=z.number().finite().min(0).max(1),
 birthsSchema=z.object({spectrum:z.literal('normalized-fuel-chi'),spontaneousNeutronsPerEvent:positive,
  emission_neutrons_s_g:z.object({U235:positive,U238:positive}).strict(),
  installedRecoverablePowerAtAgeZero_W:positive,installedNeutronExport_MeV:positive,
  installedSupport:z.literal('uniform-capsule-envelope')}).strict(),
 poisonSchema=z.object({captureGroups:z.tuple([z.literal(7)]),XeBarn:positive,SmBarn:positive,
  yieldI:fraction,yieldXe:fraction,yieldPm:fraction,
  halfLifeHours:z.object({I:positive,Xe:positive,Pm:positive}).strict()}).strict(),
 sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')

export function parseFuelHistoryLaws(document:string){
 return {births:birthsSchema.parse(configurationBlock(document,'reference-external-births')),
  poison:poisonSchema.parse(configurationBlock(document,'reference-configuration-added-material').poison)}
}

/** No arbitrary cell tie at a capsule centre on an axial boundary. */
export function capsuleBirthSupport(regions:z.infer<typeof sourceRegionSchema>[],radius:number,length:number,centre:number){
 if(!Number.isFinite(radius+length+centre)||radius<=0||length<=0)throw Error('Invalid installed capsule support')
 const volume=Math.PI*radius*radius*length,rows:{region:number,fraction:number}[]=[]
 for(let region=0;region<regions.length;region++){
  const r=regions[region]!,dz=Math.max(0,Math.min(centre+length/2,r.z1_m??-Infinity)-Math.max(centre-length/2,r.z0_m??Infinity))
  if(dz===0||!r.box)continue
  // The stationary central capsule must lie inside any clipped reaction disk;
  // otherwise rectangle overlap alone would invent unrepresented births.
  const a=diskRectangleArea(radius,r.box)
  if(a===0)continue
  if(r.diskRadius_m!==undefined&&radius>r.diskRadius_m)throw Error('Capsule crosses represented source disk')
  rows.push({region,fraction:a*dz/volume})
 }
 const total=rows.reduce((s,q)=>s+q.fraction,0)
 if(rows.length===0||Math.abs(total-1)>2e-11)throw Error('Incomplete or duplicated installed birth support')
 return rows
}

export function compileFuelHistoryInputs(partitionReceipt:unknown,materialReceipt:unknown,documents:readonly string[]){
 if(documents.length!==5)throw Error('Expected configuration, heat, cold source, handling and apparatus owners')
 const [configuration,heatOwner,coldOwner,handlingOwner,apparatusOwner]=documents as [string,string,string,string,string],
  laws=parseFuelHistoryLaws(configuration),record=parseConfigurationFuel(configuration),
  heat=compileDecayHistory(parseDecayHistory(heatOwner)),
  fuel=compileFuelInputs(partitionReceipt,materialReceipt,record,heat.promptFissionEnergy_J),
  source=parseColdNuclear(coldOwner).source,h=parseFuelHandling(handlingOwner),a=parseNuclearObservation(apparatusOwner),
  regions=z.object({result:z.object({regions:z.array(sourceRegionSchema)})}).parse(partitionReceipt).result.regions,
  p=laws.poison,cfLambda=Math.LN2/(source.halfLife_year*365.25*86400),
  survival=Math.exp(-cfLambda*source.ageAtPreparation_year*365.25*86400),
  cf={initial_energy_j:laws.births.installedRecoverablePowerAtAgeZero_W/cfLambda*survival,
   initial_neutrons_per_second:source.birthEmission_neutrons_s*survival,decay_rate:cfLambda,
   birth_export_j_per_neutron:laws.births.installedNeutronExport_MeV*1.602176634e-13},
  // Reference emission scales with the SAME finite isotope counts at each call.
  segments=fuel.stocks.map(s=>({reference_u235:s.reference_reserve,reference_u238:s.reference_fertile,
   sf235_neutrons_per_second:s.reference_reserve/6.02214076e23*record.freshFuel.u235MolarMass_kg_mol*1000*laws.births.emission_neutrons_s_g.U235,
   sf238_neutrons_per_second:s.reference_fertile/6.02214076e23*record.freshFuel.u238MolarMass_kg_mol*1000*laws.births.emission_neutrons_s_g.U238})),
  poison={yield_i:p.yieldI,yield_xe:p.yieldXe,yield_pm:p.yieldPm,
   lambda_i:Math.LN2/(p.halfLifeHours.I*3600),lambda_xe:Math.LN2/(p.halfLifeHours.Xe*3600),
   lambda_pm:Math.LN2/(p.halfLifeHours.Pm*3600),xe_sigma_m2:p.XeBarn*1e-28,sm_sigma_m2:p.SmBarn*1e-28},
  support=capsuleBirthSupport(regions,a.capsuleOD_m/2,a.capsuleLength_m,h.sourceCapsule_m)
 if(cf.decay_rate*cf.initial_energy_j<cf.initial_neutrons_per_second*cf.birth_export_j_per_neutron)
  throw Error('Installed neutron export exceeds finite emitter release')
 if(heat.groups.length!==25)throw Error('Actual fuel history needs its owned two-feed 25-store kernel')
 return {fuel,segments,poison,heat,cf,support,spontaneousNeutronsPerEvent:laws.births.spontaneousNeutronsPerEvent,
  counts:{...fuel.counts,fuelHistoryCoordinates:34*segments.length,installedEmitterCoordinates:1,
   totalCoordinates:fuel.counts.neutronCoordinates+fuel.counts.precursorCoordinates+34*segments.length+1},
  identities:{...fuel.identities,installedEmitter:source.identity},
  preparation:'ORIGINAL fresh cold source: zero N/C, consumed progress, poisons/products and E25; aged finite Cf energy',
  spectrum:laws.births.spectrum,advancedSeconds:0,completeReactorOperator:false,
  missingPhysicalContributions:['moderator/passive/optical target and product history joins and their transport sensitivities',
   'complete represented transport/time advancement','finite thermal state and remaining capture-energy recipients']}
}

/** Offline qualification fixture only; not a second product API. */
export function nativeFuelHistoryFixture(input:ReturnType<typeof compileFuelHistoryInputs>){
 const words=nativeFuelFixture(input.fuel).trim().split(/\s+/),
  fields:(string|number)[]=[words.length,...words,input.segments.length,
   ...input.segments.flatMap(s=>Object.values(s)),...Object.values(input.poison),
   input.heat.groups.length,input.heat.fissionEnergy_J,
   ...input.heat.groups.flatMap(g=>[g.feed==='fission'?0:1,g.energy_J_per_event,g.lambda_s_inv]),
   input.spontaneousNeutronsPerEvent,...Object.values(input.cf),input.support.length,
   ...input.support.flatMap(s=>[s.region,s.fraction])]
 return fields.join('\n')+'\n'
}

const owners=['systems/reactor/configuration-source-and-history.md','systems/reactor/heat-and-history.md',
 'systems/reactor/cold-source-and-startup.md','systems/reactor/fuel-handling-and-pool.md',
 'systems/instrumentation/nuclear-observation-apparatus.md']
export async function qualifyFuelHistoryInputs(partition:string,material:string,wiki:string,output:string){
 const began=performance.now(),allowanceMs=60_000
 try{await readFile(output);throw Error('Receipt exists; refusing overwrite')}
 catch(e){if(!(e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT'))throw e}
 const names=[...new Set([...owners,...coldSourceMaterialOwnerFiles])],
  paths=[resolve(partition),resolve(material),...names.map(p=>join(resolve(wiki),p))],
  texts=await Promise.all(paths.map(p=>Bun.file(p).text())),parents=texts.slice(0,2).map(s=>JSON.parse(s)),
  documents=new Map(names.map((name,i)=>[name,texts[i+2]!])),preparationStart=performance.now(),
  current=compileColdSourceMaterialOwners(coldSourceMaterialOwnerFiles.map(name=>documents.get(name)!))
 // Recompile exact current semantic geometry, not stale whole-file hashes that
 // change when qualification prose is appended to a living owner document.
 if(sha(JSON.stringify(current.partition))!==sha(JSON.stringify(parents[0].result))
  ||sha(JSON.stringify(current.result))!==sha(JSON.stringify(parents[1].result)))throw Error('Current ORIGINAL geometry/material differs from parent receipts')
 const input=compileFuelHistoryInputs(parents[0],parents[1],owners.map(name=>documents.get(name)!)),fixture=nativeFuelHistoryFixture(input),
  preparationSeconds=(performance.now()-preparationStart)/1000,
  root=resolve(import.meta.dir,'../native/process-plant'),
  native=['src/fuel_source.rs','src/fuel_history.rs','src/heat_history.rs','qualification/fuel-history.rs'],
  helpers=['source-fuel','source-laws','decay-history','cold-nuclear','fuel-handling','nuclear-observation','source-partition',
   'source-material','source-faces','fuel-construction','control-absorber','primary-mechanics','initialization'],
  sourcePaths=[import.meta.path,...helpers.map(s=>resolve(import.meta.dir,'reference-design-'+s+'.ts')),...native.map(p=>join(root,p))],
  sources=await Promise.all(sourcePaths.map(p=>readFile(p))),scratch=await mkdtemp(join(tmpdir(),'ld01-fuel-history-')),
  directory=resolve(output)+'.artifacts',fixturePath=join(directory,'input.txt'),binary=join(scratch,'fuel-history')
 await mkdir(directory)
 await writeFile(fixturePath,fixture,{flag:'wx'})
 await Promise.all(sourcePaths.map((p,i)=>writeFile(join(directory,`${i}-${basename(p)}`),sources[i]!,{flag:'wx'})))
 async function execute(command:string[]){
  const remaining=allowanceMs-(performance.now()-began)
  if(remaining<=0)return {command,exitCode:null,stdout:'',stderr:'Aggregate allowance exhausted',timedOut:true}
  const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},remaining)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,exitCode,stdout,stderr,timedOut}
 }
 const toolchain=await execute(['rustc','--version']),
  compile=await execute(['rustc','--edition=2024','-C','opt-level=2',join(root,'qualification/fuel-history.rs'),'-o',binary]),
  run=compile.exitCode===0&&!compile.timedOut?await execute([binary,fixturePath]):undefined,
  bytes=compile.exitCode===0?await readFile(binary):undefined
 if(bytes)await writeFile(join(directory,'fuel-history'),bytes,{flag:'wx'})
 const unchanged=(await Promise.all(paths.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i])
  &&(await Promise.all(sourcePaths.map(p=>readFile(p)))).every((s,i)=>s.equals(sources[i]!)),
  elapsedSeconds=(performance.now()-began)/1000,
  receipt={passed:toolchain.exitCode===0&&!toolchain.timedOut&&compile.exitCode===0&&!compile.timedOut
   &&run?.exitCode===0&&!run.timedOut&&unchanged&&elapsedSeconds<=allowanceMs/1000,
   allowanceSeconds:allowanceMs/1000,elapsedSeconds,preparationSeconds,input,currentGeometryRecompiled:true,
   consumed:paths.map((path,i)=>({path,sha256:sha(texts[i]!)})),
   sources:sourcePaths.map((path,i)=>({path,sha256:sha(sources[i]!)})),fixtureSHA256:sha(fixture),binarySHA256:bytes?sha(bytes):undefined,
   toolchain,compile,run,unchanged,artifacts:{directory},
   scope:'One actual fuel/birth/poison/E25 RHS and directional derivative assembly, not complete source or time advancement. No real-time throughput claim.'}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt
}
if(import.meta.main){
 const [partition,material,wiki,output]=Bun.argv.slice(2)
 if(!partition||!material||!wiki||!output||Bun.argv.length!==6)throw Error('Expected partition/material receipts, LD-01 root and NEW result')
 const r=await qualifyFuelHistoryInputs(partition,material,wiki,output)
 console.log(JSON.stringify({passed:r.passed,elapsedSeconds:r.elapsedSeconds,counts:r.input.counts,result:r.run?.stdout,output}))
 if(!r.passed)process.exitCode=1
}
