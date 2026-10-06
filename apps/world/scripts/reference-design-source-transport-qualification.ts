/** One bounded actual-input material transaction, NOT a reactor trajectory. */
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,join,resolve} from 'node:path'
import {compileFuelInputs,nativeFuelFixture,parseConfigurationFuel} from './reference-design-source-fuel'
import {compileModeratorInputs,nativeModeratorFixture,parseConfigurationModerator} from './reference-design-source-moderator'
import {compileDecayHistory,parseDecayHistory} from './reference-design-decay-history'
import {compileSourceFaces} from './reference-design-source-faces'
import {compileSourcePartition} from './reference-design-source-partition'
import {compileColdSourceMaterial,parseOperatingFuelCohorts} from './reference-design-source-material'
import {parseNuclearObservation} from './reference-design-nuclear-observation'
import {parseColdNuclear} from './reference-design-cold-nuclear'
import {parsePrimaryWaterInputs,primaryWaterOwnerFiles} from './reference-design-source-water'
import {compileOriginalPassiveGeometry} from './reference-design-source-passive'
import {compileCylinderInputs} from './reference-design-source-cylinder'
import {compileConverterHeat} from './reference-design-converter-heat'
import {assembleReceivingWater,sampleReceivingLiquid} from './reference-design-source-receiving-water'
import {compileTransportGeometry,type MaterialSupportBinding} from './reference-design-source-transport'
import {nativeIf97HeaderSha256,nativeIf97LicenseSha256,nativeIf97Source} from './reference-design-if97-primitives'
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
const extraOwners=['systems/reactor/configuration-source-and-history.md','systems/reactor/heat-and-history.md',
 'systems/reactor/radial-energy-transient.md','systems/instrumentation/nuclear-observation-apparatus.md','systems/reactor/cold-source-and-startup.md']

/** Receiving stock identities/property preparation stay separate from PRIMARY.
 * Sharing the moderator reaction law does not forge a primary water receipt. */
function joinModerator(primary:ReturnType<typeof compileModeratorInputs>,receiving:ReturnType<typeof assembleReceivingWater>){
 const regions=new Map(primary.identities.regions.map((id,i)=>[id,i])),seen=new Set(primary.identities.rows),
  intersections=[...primary.intersections],stocks=[...primary.stocks],rows=[...primary.identities.rows]
 for(const row of receiving.sourceIncidence){
  const key=row.owner+'|'+row.sourceRegionId,region=regions.get(row.sourceRegionId),q=row.amount
  if(region===undefined||seen.has(key))throw Error('Unknown/duplicated receiving moderator incidence')
  seen.add(key);rows.push(key);intersections.push({region,volume:q.volume_m3})
  stocks.push({water_mass:q.water_kg,liquid_volume:q.volume_m3,hydrogen_target:q.Htarget,hydrogen_product:q.HcaptureProduct,mobile_boron10:q.mobileN10})
 }
 const covered=primary.regionVolumes.map(()=>0)
 for(const e of intersections)covered[e.region]!+=e.volume
 covered.forEach((v,r)=>{if(v>primary.regionVolumes[r]!*(1+3e-11))throw Error('Primary/receiving water overlaps or exceeds region')})
 return {...primary,intersections,stocks,identities:{...primary.identities,rows},counts:{...primary.counts,
  nativeOwners:primary.counts.nativeOwners+receiving.nativeOwners.length,intersections:intersections.length}}
}

export function compileMaterialSourceCheck(partitionText:string,materialText:string,waterText:string,docs:readonly string[],liquid:Parameters<typeof assembleReceivingWater>[1]){
 const d=parsePrimaryWaterInputs(docs.slice(0,primaryWaterOwnerFiles.length)),offset=primaryWaterOwnerFiles.length,
  source=docs[offset]!,heat=docs[offset+1]!,partition=compileSourcePartition(d),
  material=compileColdSourceMaterial(partition,{fuel:d.fuel,handling:d.handling,grid:parseOperatingFuelCohorts(docs[offset+2]!),
   apparatus:parseNuclearObservation(docs[offset+3]!),source:{birthEmission_neutrons_s:parseColdNuclear(docs[offset+4]!).source.birthEmission_neutrons_s}})
 if(sha(JSON.stringify(partition))!==sha(JSON.stringify(JSON.parse(partitionText).result))
  ||sha(JSON.stringify(material))!==sha(JSON.stringify(JSON.parse(materialText).result)))throw Error('Current original owners differ from admitted material/partition')
 if(liquid.pressure_Pa!==d.head.cnvPressure_Pa||liquid.temperature_K!==d.head.cnvTemperature_K)throw Error('Receiving native property datum differs from owner')
 const f=compileFuelInputs(JSON.parse(partitionText),JSON.parse(materialText),parseConfigurationFuel(source),
   compileDecayHistory(parseDecayHistory(heat)).promptFissionEnergy_J),
  primary=compileModeratorInputs(JSON.parse(partitionText),JSON.parse(waterText),parseConfigurationModerator(source)),
  faces=compileSourceFaces(partition,d.gates,[0,0]),passive=compileOriginalPassiveGeometry(partition,d,material,faces.faces,source),
  molar=d.chemistry.isotopeFraction*d.chemistry.isotope10MolarMass_kg_mol+(1-d.chemistry.isotopeFraction)*d.chemistry.isotope11MolarMass_kg_mol,
  receiving=assembleReceivingWater(passive.receivingPieces,liquid,{markerRatio:d.head.poolTracerRatio,
   atomsPerMarker:d.chemistry.avogadro_mol*d.chemistry.isotopeFraction/molar,avogadro:d.chemistry.avogadro_mol}),
  m=joinModerator(primary,receiving),faceReceipt=JSON.stringify({partitionSHA256:sha(partitionText),result:faces}),
  bindings:MaterialSupportBinding[]=[...passive.opticalFaces.map(q=>({kind:'optical' as const,faceIndex:q.faceIndex,supportId:q.supportId,
   targetIds:q.layers.flatMap(l=>l.columns.map(c=>c.targetId))})),...passive.headBulkAdmission.map(q=>({kind:'bulk' as const,
   faceIndex:q.faceIndex,supportId:'HEAD.MOUTH',materialIds:['HEAD.SLAB',...primary.identities.rows.filter(id=>id.endsWith('|'+q.receiverRegionId))]}))],
  t=compileTransportGeometry(partitionText,faceReceipt,f.law.speed,bindings),
  apparatus=parseNuclearObservation(docs[offset+3]!),cylinder=compileCylinderInputs(partition,d,material,passive,apparatus,source),
  converter=cylinder.targets[cylinder.converterTarget]!,
  targets=[...passive.stocks.flatMap(s=>s.targets),{id:converter.id,atoms:converter.atoms,bindingEmission_J:converter.binding_emission}],
  converterHeat=compileConverterHeat(d,apparatus,primary,source,parseColdNuclear(docs[offset+4]!).source.birthEmission_neutrons_s),
  targetIndices=new Map(targets.map((q,i)=>[q.id,i])),index=(id:string)=>{
   const n=targetIndices.get(id);if(n===undefined)throw Error('Unowned passive target '+id);return n},
  optical=new Map(passive.opticalFaces.map(q=>[q.faceIndex,q])),collision=t.regionVolumes.map(()=>Array(7).fill(0) as number[])
 if(targetIndices.size!==targets.length||f.identities.regions.some((id,i)=>id!==m.identities.regions[i])
  ||f.law.speed.some((v,g)=>v!==m.law.speed[g]||v!==passive.speed[g]))throw Error('Inconsistent composed identities')
 for(const e of f.intersections)for(let g=0;g<7;g++)collision[e.region]![g]!+=e.volume/f.regionVolumes[e.region]!
  *(f.law.absorption[g]!+f.law.scatter[g]!.reduce((a,b)=>a+b,0))
 for(let i=0;i<m.intersections.length;i++){
  const e=m.intersections[i]!,s=m.stocks[i]!,V=m.regionVolumes[e.region]!,fill=s.water_mass/(m.law.reference_density*V),
   H=s.hydrogen_target/(s.hydrogen_target+s.hydrogen_product)
  for(let g=0;g<7;g++)collision[e.region]![g]!+=fill*(m.law.absorption[g]!*H+m.law.scatter[g]!.reduce((a,b)=>a+b,0))
   +m.law.boron_sigma[g]!*s.mobile_boron10/V
 }
 for(const e of passive.nativeBulk.incidence){
  const s=passive.nativeBulk.stocks[e.stock]!,fraction=e.volume/t.regionVolumes[e.region]!
  for(let g=0;g<7;g++)collision[e.region]![g]!+=fraction*s.scatter[g]!
   +s.targets.reduce((sum,q)=>sum+targets[index(q.id)]!.atoms*e.volume/s.volume*q.sigma[g]!/t.regionVolumes[e.region]!,0)
 }
 if(collision.flat().some(v=>!Number.isFinite(v)||v<0))throw Error('Nonfinite/negative material collision')
 const ff=nativeFuelFixture(f).trim().split(/\s+/),mf=nativeModeratorFixture(m).trim().split(/\s+/),
  fields:(string|number)[]=[ff.length,...ff,mf.length,...mf,targets.length,...targets.map(q=>q.atoms),
   ...targets.flatMap(q=>q.bindingEmission_J),passive.nativeBulk.stocks.length]
 for(const s of passive.nativeBulk.stocks){fields.push(s.volume,...s.scatter,s.targets.length)
  for(const q of s.targets)fields.push(index(q.id),...q.sigma)}
 fields.push(passive.nativeBulk.incidence.length,...passive.nativeBulk.incidence.flatMap(e=>[e.stock,e.region,e.volume]),
  t.regionVolumes.length,t.faces.length,...t.speed,...t.regionVolumes,...t.envelopeLengths)
 t.faces.forEach((face,i)=>{
  const q=optical.get(i);fields.push(face.left,face.right??-1,face.area,face.left_distance,face.right_distance??0,q?.layers.length??0)
  if(q)for(const layer of q.layers){fields.push(layer.columns.length)
   for(const c of layer.columns)fields.push(index(c.targetId),c.atoms_per_m2,...c.sigma_m2)}
 })
 fields.push(...collision.flat(),cylinder.targets.length)
 for(const q of cylinder.targets)fields.push(index(q.id),q.inner_radius,q.outer_radius,q.length,q.multiplicity,...q.sigma,q.escape_depth,q.collection)
 fields.push(cylinder.intersections.length,...cylinder.intersections.flatMap(q=>[q.target,q.region,q.share]),index(converter.id),
  ...Object.values(converterHeat.geometry),...converterHeat.emission,...Object.values(converterHeat.liquid))
 return {fixture:fields.join('\n')+'\n',faceReceipt,materialPayload:{passive,receiving,cylinder,converterHeat},input:{completeReactorOperator:false,advancedSeconds:0,
  probe:'Actual cold material coefficients; zero and artificial positive/signed N/C algebra, NOT a reached trajectory',
  counts:{regions:t.regionVolumes.length,fuelSegments:f.counts.segments,fuelCohorts:f.counts.fuelCohorts,
   primaryWaterIntersections:primary.counts.intersections,receivingWaterIntersections:receiving.sourceIncidence.length,
   bulkStocks:passive.stocks.length,bulkIntersections:passive.volumeMaterial.length,passiveTargets:targets.length,
   volumeCaptureTargets:passive.nativeBulk.targets.length,
   opticalCaptureTargets:new Set(passive.opticalFaces.flatMap(q=>q.layers.flatMap(l=>l.columns.map(c=>c.targetId)))).size,
   bodyCylinderTargets:cylinder.targets.length-1,converterTargets:1,cylinderIntersections:cylinder.intersections.length,
   opticalFaces:passive.opticalFaces.length,bulkHeadFaces:passive.headBulkAdmission.length,
   sharedFaces:t.faces.filter(q=>q.right!==undefined).length,escapeFaces:t.faces.filter(q=>q.right===undefined).length,
   regionsWithNoPresentCollision:collision.filter(gs=>gs.every(v=>v===0)).length},
  missingPhysicalContributions:['complete births/poison/finite-target/product/E25/Mn56 histories and source advancement',
   'body and other nonconverter photon/contact heat paths; remaining solid/apparatus reactions and retained deposits',
   'all finite thermal state advancement, acquired detector realization and whole-plant coupling'],reactionOmissions:passive.reactionOmissions,
  collisionScope:'Independent Bun/native subtotal covers fuel, primary/receiving water and ordinary passive bulk. Native separately adds actual cylinder/converter effective capture collision before transport; geometry/law tested independently.',
  geometryScope:'Original seven-group comparator, not a selected production source resolution.',
  converterHeatScope:converterHeat.scope,nonconverterEmissionIsDepositedHeat:false}}
}

export async function qualifyMaterialSourceCheck(paths:string[],wiki:string,if97:string,output:string){
 const began=performance.now(),allowanceMs=60_000
 if(paths.length!==3)throw Error('Expected partition, material, qualified primary water receipts')
 try{await readFile(output);throw Error('Receipt exists; refusing overwrite')}
 catch(e){if(!(e&&typeof e==='object'&&'code' in e&&e.code==='ENOENT'))throw e}
 const ownerPaths=[...primaryWaterOwnerFiles,...extraOwners].map(p=>join(resolve(wiki),p)),
  consumed=[...paths.map(p=>resolve(p)),...ownerPaths],texts=await Promise.all(consumed.map(p=>Bun.file(p).text())),docs=texts.slice(3),
  d=parsePrimaryWaterInputs(docs.slice(0,primaryWaterOwnerFiles.length)),root=resolve(import.meta.dir,'../native/process-plant'),
  helpers=['source-transport','source-passive','source-cylinder','converter-heat','source-receiving-water','source-water','source-material','source-fuel','source-moderator',
   'source-laws','source-faces','source-partition','fuel-transfer','decay-history','fuel-handling','fuel-construction',
   'control-absorber','current-cold-parent','head-pool','primary-mechanics','initialization','cold-pressure','chemistry-lifecycle',
   'nuclear-observation','cold-nuclear','if97-primitives'],
  nativeSources=await Array.fromAsync(new Bun.Glob('src/**/*.{rs,cpp}').scan({cwd:root})),
  sourcePaths=[import.meta.path,...helpers.map(s=>resolve(import.meta.dir,'reference-design-'+s+'.ts')),
   ...nativeSources.sort().map(s=>join(root,s)),
   ...['Cargo.toml','Cargo.lock','build.rs','examples/receiving-water.rs','qualification/source-transport.rs'].map(s=>join(root,s))],
  sources=await Promise.all(sourcePaths.map(p=>readFile(p))),scratch=await mkdtemp(join(tmpdir(),'ld01-source-material-')),
  artifactDirectory=resolve(output)+'.artifacts',fixturePath=join(artifactDirectory,'input.txt'),binary=join(scratch,'source-transport'),
  header=await readFile(join(resolve(if97),'IF97.h')),license=await readFile(join(resolve(if97),'LICENSE'))
 if(sha(header)!==nativeIf97HeaderSha256||sha(license)!==nativeIf97LicenseSha256)throw Error('Pinned property source differs')
 await mkdir(artifactDirectory)
 await Promise.all(sourcePaths.map((p,i)=>writeFile(join(artifactDirectory,`${i}-${basename(p)}`),sources[i]!,{flag:'wx'})))
 await writeFile(join(scratch,'if97-bridge.cpp'),nativeIf97Source(true)+'\n'+await readFile(join(root,'src/if97-bridge.cpp'),'utf8'),{flag:'wx'})
 const env={...process.env,LEITBILD_IF97_DIR:resolve(if97),LEITBILD_IF97_BRIDGE_DIR:scratch,CARGO_TARGET_DIR:join(scratch,'target')}
 async function execute(command:string[]){
  const remaining=allowanceMs-(performance.now()-began)
  if(remaining<=0)return {command,exitCode:null,stdout:'',stderr:'Aggregate allowance exhausted',timedOut:true}
  const child=Bun.spawn(command,{env,stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},remaining)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,exitCode,stdout,stderr,timedOut}
 }
 const version=await execute(['rustc','--version']),propertyBuild=await execute(['cargo','build','--release','--example','receiving-water','--manifest-path',join(root,'Cargo.toml')])
 if(propertyBuild.exitCode!==0||propertyBuild.timedOut)throw Error('Native receiving build refused: '+propertyBuild.stderr)
 const receivingBinary=join(scratch,'target/release/examples/receiving-water'),
  property=await sampleReceivingLiquid(receivingBinary,d.head.cnvPressure_Pa,d.head.cnvTemperature_K,allowanceMs-(performance.now()-began)),
  preparationStart=performance.now(),prepared=compileMaterialSourceCheck(texts[0]!,texts[1]!,texts[2]!,docs,property.property),
  preparationSeconds=(performance.now()-preparationStart)/1000
 await writeFile(fixturePath,prepared.fixture,{flag:'wx'});await writeFile(join(artifactDirectory,'faces.json'),prepared.faceReceipt,{flag:'wx'})
 await writeFile(join(artifactDirectory,'material.json'),JSON.stringify(prepared.materialPayload),{flag:'wx'})
 await writeFile(join(artifactDirectory,'receiving-output.ndjson'),property.stdout,{flag:'wx'})
 const propertyBytes=await readFile(receivingBinary)
 await writeFile(join(artifactDirectory,'receiving-water'),propertyBytes,{flag:'wx'})
 const compile=await execute(['rustc','--edition=2024','-C','opt-level=2',join(root,'qualification/source-transport.rs'),'-o',binary]),
  run=compile.exitCode===0&&!compile.timedOut?await execute([binary,fixturePath]):undefined,
  bytes=compile.exitCode===0?await readFile(binary):undefined
 if(bytes)await writeFile(join(artifactDirectory,'source-transport'),bytes,{flag:'wx'})
 const unchanged=(await Promise.all(consumed.map(p=>Bun.file(p).text()))).every((s,i)=>s===texts[i])
  &&(await Promise.all(sourcePaths.map(p=>readFile(p)))).every((s,i)=>s.equals(sources[i]!)),elapsedSeconds=(performance.now()-began)/1000,
  result={passed:version.exitCode===0&&!version.timedOut&&compile.exitCode===0&&!compile.timedOut
   &&run?.exitCode===0&&!run.timedOut&&unchanged&&elapsedSeconds<=allowanceMs/1000,
   allowanceSeconds:allowanceMs/1000,elapsedSeconds,preparationSeconds,input:prepared.input,
   consumed:consumed.map((path,i)=>({path,sha256:sha(texts[i]!)})),sources:sourcePaths.map((path,i)=>({path,sha256:sha(sources[i]!)})),
   fixtureSHA256:sha(prepared.fixture),binarySHA256:bytes?sha(bytes):undefined,receivingBinarySHA256:sha(propertyBytes),
   upstream:{headerSHA256:sha(header),licenseSHA256:sha(license)},version,propertyBuild,compile,run,unchanged,
   artifacts:{directory:artifactDirectory},scope:'Nonadvancing actual body/converter/material composition plus converter-specific physical energy-recipient/export rates. No complete neutron source, history/thermal advancement, calibrated reactor or real-time claim.'}
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result
}
if(import.meta.main){
 const [partition,material,water,wiki,if97,output]=Bun.argv.slice(2)
 if(Bun.argv.length!==8||!partition||!material||!water||!wiki||!if97||!output)throw Error('Expected three receipts, LD-01 wiki root, pinned IF97 directory and NEW receipt')
 const r=await qualifyMaterialSourceCheck([partition,material,water],wiki,if97,output)
 console.log(JSON.stringify({passed:r.passed,elapsedSeconds:r.elapsedSeconds,preparationSeconds:r.preparationSeconds,input:r.input.counts,result:r.run?.stdout,output}))
 if(!r.passed)process.exitCode=1
}
