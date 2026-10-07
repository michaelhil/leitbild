/** ORIGINAL empty-receiving spatial closure. Core, closed-head cells and all
 * physical material/history owners remain. This is not an exact optimization,
 * a generic remesher, or permission to model loaded racks/fuel movement. */
import {sourceRegionSchema,type SourceRegion} from './reference-design-source-partition'
import type {SourceFace} from './reference-design-source-faces'
import {compileSourceEvolution,sourceEvolutionOwnerFiles} from './reference-design-source-evolution'
import {nativeFuelHistoryFixture} from './reference-design-fuel-history'
import {nativeMaterialSourceFixture,originalMaterialCollision,type MaterialNativeInput} from './reference-design-source-transport-qualification'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join,resolve,basename} from 'node:path'
import {sourceHelperFiles} from './reference-design-source-evolution-qualification'

type Prepared=ReturnType<typeof compileSourceEvolution>
const close=(a:number,b:number,label:string)=>{
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(Math.abs(a),Math.abs(b),1e-30))throw Error('Receiving closure: '+label)
}
const receiving=(r:SourceRegion)=>['WELL','CANAL','POOL'].includes(r.compartment)

export function compileReceivingResolution(fine:Prepared,partitionText:string){
 const faceParent=JSON.parse(fine.material.faceReceipt) as {partitionSHA256:string,result:{faces:SourceFace[]}}
 if(createHash('sha256').update(partitionText).digest('hex')!==faceParent.partitionSHA256)throw Error('Receiving geometry lineage differs from material parent')
 const parsed=JSON.parse(partitionText) as {result?:{regions?:unknown}},
  regions=sourceRegionSchema.array().nonempty().parse(parsed?.result?.regions),
  {nativeInputs:old,materialPayload:payload}=fine.material,
  rawFaces=faceParent.result.faces,
  fineIndex=new Map(regions.map((r,i)=>[r.id,i]))
 if(fineIndex.size!==regions.length||regions.length!==old.transport.regionVolumes.length
  ||regions.some((r,i)=>r.id!==old.fuel.identities.regions[i]||r.volume_m3!==old.transport.regionVolumes[i])
  ||rawFaces.length!==old.transport.faces.length)throw Error('Receiving partition/consumer identity mismatch')
 const well=regions.filter(r=>r.compartment==='WELL'),bottom=Math.min(...well.map(r=>r.z0_m!)),
  coarse:SourceRegion[]=[],members:number[][]=[],group=new Map<string,number>(),mapping:number[]=[]
 if(!well.length||!Number.isFinite(bottom))throw Error('Missing original head-bearing WELL band')
 for(const [i,r] of regions.entries()){
  const retain=!receiving(r)||r.compartment==='WELL'&&r.z0_m===bottom,
   key=retain?r.id:`${r.compartment}/slab/${r.z0_m}/${r.z1_m}`
  let c=group.get(key)
  if(c===undefined){c=coarse.length;group.set(key,c);coarse.push({...r,id:key});members.push([])}
  members[c]!.push(i);mapping.push(c)
 }
 const centres=coarse.map((r,c)=>{
  const own=members[c]!.map(i=>regions[i]!),V=own.reduce((s,q)=>s+q.volume_m3,0)
  if(own.length===1)return undefined // untouched fine-side distances stay exact
  if(!own.every(q=>q.box&&q.diskRadius_m===undefined&&q.z0_m===r.z0_m&&q.z1_m===r.z1_m&&q.envelopeLength_m===r.envelopeLength_m))
   throw Error('Nonrectangular or mixed-boundary receiving union')
  const box={x0:Math.min(...own.map(q=>q.box!.x0)),x1:Math.max(...own.map(q=>q.box!.x1)),
   y0:Math.min(...own.map(q=>q.box!.y0)),y1:Math.max(...own.map(q=>q.box!.y1))},
   centroid=[own.reduce((s,q)=>s+q.volume_m3*(q.box!.x0+q.box!.x1)/2,0)/V,
    own.reduce((s,q)=>s+q.volume_m3*(q.box!.y0+q.box!.y1)/2,0)/V,(r.z0_m!+r.z1_m!)/2]
  close(V,(box.x1-box.x0)*(box.y1-box.y0)*(r.z1_m!-r.z0_m!),'gross slab volume')
  // A centred symmetric slab has a zero centroid, not zero summation scale.
  for(const axis of [0,1] as const){const expected=axis===0?(box.x0+box.x1)/2:(box.y0+box.y1)/2,
   length=axis===0?box.x1-box.x0:box.y1-box.y0
   if(Math.abs(centroid[axis]!-expected)>4e-10*length)throw Error('Receiving slab moment does not close')}
  coarse[c]={id:r.id,compartment:r.compartment,box,z0_m:r.z0_m,z1_m:r.z1_m,volume_m3:V,envelopeLength_m:r.envelopeLength_m}
  return centroid
 })
 const mapped=(i:number)=>{const r=mapping[i];if(r===undefined)throw Error('Unowned fine region');return r},
  mappedId=(id:string)=>{const i=fineIndex.get(id);if(i===undefined)throw Error('Unknown physical incidence region');return coarse[mapped(i)]!.id},
  volumes=coarse.map(r=>r.volume_m3),ids=coarse.map(r=>r.id),
  fuel={...old.fuel,regionVolumes:volumes,intersections:old.fuel.intersections.map(e=>{
   if(regions[e.region]!.compartment!=='ACTIVE'||members[mapped(e.region)]!.length!==1)throw Error('Loaded receiving support is outside selected closure')
   return {...e,region:mapped(e.region)}}),identities:{...old.fuel.identities,regions:ids},
   counts:{...old.fuel.counts,regions:coarse.length,neutronCoordinates:7*coarse.length}},
  bulk=payload.passive.nativeBulk,materialGroups=new Map<string,typeof payload.passive.volumeMaterial[number]>()
 for(const q of payload.passive.volumeMaterial){const region=mapped(q.region),key=q.stock+'|'+region,row=materialGroups.get(key)
  if(row)row.volume_m3+=q.volume_m3
  else materialGroups.set(key,{...q,region,sourceRegionId:mappedId(q.sourceRegionId)})
 }
 const volumeMaterial=[...materialGroups.values()],incidence=volumeMaterial.map(q=>({stock:q.stock,region:q.region,volume:q.volume_m3}))
 const waterGroups=new Map<string,number>(),waterIntersections:typeof old.moderator.intersections=[],waterStocks:typeof old.moderator.stocks=[],
  waterRows:typeof fine.projection.rows=[],waterIds:string[]=[]
 old.moderator.intersections.forEach((e,i)=>{
  const row=fine.projection.rows[i]!,stock=old.moderator.stocks[i]!,region=mapped(e.region),key=fine.projection.owners[row.owner]!.id+'|'+ids[region]
  let c=waterGroups.get(key)
  if(c===undefined){c=waterIntersections.length;waterGroups.set(key,c);waterIds.push(key);waterIntersections.push({region,volume:0})
   waterStocks.push({water_mass:0,liquid_volume:0,hydrogen_target:0,hydrogen_product:0,mobile_boron10:0});waterRows.push({owner:row.owner,h_fraction:0,b_fraction:0})}
  waterIntersections[c]!.volume+=e.volume
  for(const k of Object.keys(stock) as (keyof typeof stock)[])waterStocks[c]![k]+=stock[k]
  waterRows[c]!.h_fraction+=row.h_fraction;waterRows[c]!.b_fraction+=row.b_fraction
 })
 const projection={...fine.projection,rows:waterRows},moderator={...old.moderator,regionVolumes:volumes,intersections:waterIntersections,stocks:waterStocks,
  identities:{...old.moderator.identities,regions:ids,rows:waterIds},counts:{...old.moderator.counts,regions:coarse.length,intersections:waterIntersections.length,neutronCoordinates:7*coarse.length}}
 // The head cannot be diluted across the plan of its receiving bay. All its
 // original steel/hole/water cuts remain distinct, not only its mouth area.
 for(const e of bulk.incidence)if(bulk.stocks[e.stock]!.targets.some(t=>t.id.startsWith('HEAD.SLAB/'))&&members[mapped(e.region)]!.length!==1)
  throw Error('Head-bearing material was homogenized')
 const optical=new Map(payload.passive.opticalFaces.map(q=>[q.faceIndex,q])),
  faces:MaterialNativeInput['transport']['faces']=[],opticalFaces:typeof payload.passive.opticalFaces=[],
  faceGroups=new Map<string,number>(),faceMap:{fine:number,coarse:number|null,kind:string}[]=[],
  sideDistance=(oldRegion:number,raw:SourceFace,fallback:number)=>{
   const centre=centres[mapped(oldRegion)]
   if(!centre)return fallback
   const axis=raw.axis==='x'?0:raw.axis==='y'?1:raw.axis==='z'?2:undefined
   if(axis===undefined||raw.plane_m===undefined)throw Error('Unselected receiving face geometry')
   const d=Math.abs(centre[axis]!-raw.plane_m)
   if(!(Number.isFinite(d)&&d>0))throw Error('Nonpositive coarse side resistance distance')
   return d
  }
 for(const [i,f] of old.transport.faces.entries()){
  const raw=rawFaces[i]!,left=mapped(f.left),right=f.right===undefined?undefined:mapped(f.right),q=optical.get(i)
  if(raw.left!==regions[f.left]!.id||raw.right!==(f.right===undefined?undefined:regions[f.right]!.id))throw Error('Fine face identity drift')
  if(left===right){
   if(!q){if(f.law.kind!=='transparent')throw Error('Unknown internal face');faceMap.push({fine:i,coarse:null,kind:'cancelled-transparent'});continue}
   if(raw.support?.kind!=='rack-panel'||f.law.kind!=='optical')throw Error('Only rack panels may become internal optical sinks')
   const index=faces.length
   faces.push({...f,left,right:undefined,left_distance:0,right_distance:undefined,law:{kind:'internal-optical',targets:f.law.targets}})
   opticalFaces.push({...q,faceIndex:index});faceMap.push({fine:i,coarse:index,kind:'internal-optical'});continue
  }
  const next={...f,left,right,left_distance:sideDistance(f.left,raw,f.left_distance),
   right_distance:f.right===undefined?undefined:sideDistance(f.right,raw,f.right_distance!)}
  // Area-identical patches with different target/layer identities never merge.
  const key=q?undefined:JSON.stringify([left,right,next.left_distance,next.right_distance,raw.axis,raw.plane_m,raw.support]),prior=key===undefined?undefined:faceGroups.get(key)
  if(prior!==undefined){faces[prior]!.area+=f.area;faceMap.push({fine:i,coarse:prior,kind:f.law.kind});continue}
  const index=faces.length;faces.push(next);if(key!==undefined)faceGroups.set(key,index)
  if(q)opticalFaces.push({...q,faceIndex:index})
  faceMap.push({fine:i,coarse:index,kind:f.law.kind})
 }
 const faceIndex=(i:number)=>{const c=faceMap[i]?.coarse;if(c===undefined||c===null)throw Error('Material support was cancelled');return c},
  coarsePartitionText=JSON.stringify({result:{regions:coarse}}),
  transport={...old.transport,regionVolumes:volumes,envelopeLengths:coarse.map(r=>r.envelopeLength_m),faces,
   partitionSHA256:createHash('sha256').update(coarsePartitionText).digest('hex'),
   identities:{...old.transport.identities,regions:ids,bulkSupports:old.transport.identities.bulkSupports.map(q=>({...q,faceIndex:faceIndex(q.faceIndex),
    materialIds:q.materialIds.map(id=>{const split=id.indexOf('|');return split<0?id:id.slice(0,split+1)+mappedId(id.slice(split+1))})}))}},
  pieces=new Map<string,typeof payload.passive.receivingPieces[number]>()
 for(const q of payload.passive.receivingPieces){const sourceRegionId=mappedId(q.sourceRegionId),key=q.owner+'|'+sourceRegionId,
  row=pieces.get(key)??{owner:q.owner,sourceRegionId,volume_m3:0,momentZ_m4:0}
  row.volume_m3+=q.volume_m3;row.momentZ_m4+=q.momentZ_m4;pieces.set(key,row)}
 const receivingRows=new Map<string,typeof payload.receiving.sourceIncidence[number]>()
 for(const q of payload.receiving.sourceIncidence){const sourceRegionId=mappedId(q.sourceRegionId),key=q.owner+'|'+sourceRegionId,row=receivingRows.get(key)
  if(!row){receivingRows.set(key,{...q,sourceRegionId,amount:{...q.amount}});continue}
  for(const k of Object.keys(q.amount) as (keyof typeof q.amount)[])row.amount[k]+=q.amount[k]
 }
 const passive={...payload.passive,regionVolumes:volumes,nativeBulk:{...bulk,incidence},opticalFaces,volumeMaterial,receivingPieces:[...pieces.values()],
   headBulkAdmission:payload.passive.headBulkAdmission.map(q=>({...q,faceIndex:faceIndex(q.faceIndex),receiverRegionId:mappedId(q.receiverRegionId)}))},
  cylinder={...payload.cylinder,intersections:payload.cylinder.intersections.map(e=>({...e,region:mapped(e.region)}))},
  nativeInputs={...old,fuel,moderator,transport},materialPayload={...payload,passive,cylinder,receiving:{...payload.receiving,sourceIncidence:[...receivingRows.values()]}},
  history={...fine.history,fuel,support:fine.history.support.map(e=>({...e,region:mapped(e.region)})),
   identities:{...fine.history.identities,regions:ids},
   counts:{...fine.history.counts,regions:coarse.length,neutronCoordinates:7*coarse.length,
    totalCoordinates:fine.history.counts.totalCoordinates-7*(regions.length-coarse.length)}},
  collision=coarse.map(()=>Array(7).fill(0) as number[])
 // Constant-field volume projection is used only to retain the independent
 // ORIGINAL material subtotal. Runtime coefficients come from the new owners.
 const oldCollision=originalMaterialCollision(old,payload)
 for(const [r,c] of mapping.entries())for(let g=0;g<7;g++)collision[c]![g]!+=oldCollision[r]![g]!*regions[r]!.volume_m3/volumes[c]!
 const rebuiltCollision=originalMaterialCollision(nativeInputs,materialPayload)
 for(let r=0;r<coarse.length;r++)for(let g=0;g<7;g++)close(rebuiltCollision[r]![g]!,collision[r]![g]!,'independently rebuilt material collision')
 const materialFixture=nativeMaterialSourceFixture(nativeInputs,materialPayload,collision),
  frame=(s:string)=>{const w=s.trim().split(/\s+/);return [w.length,...w]},
  water=[projection.owners.length,...projection.owners.flatMap(o=>[o.hydrogen,o.hydrogen_product,o.boron,o.boron_product]),
   projection.rows.length,...projection.rows.flatMap(q=>[q.owner,q.h_fraction,q.b_fraction])],
  mn=[fine.manganese.length,...fine.manganese.flatMap(q=>[q.target,q.decay_rate,q.electron_j,q.photon_j])],
  fixture=[...frame(materialFixture),...frame(nativeFuelHistoryFixture(history)),...frame(water.join('\n')),...frame(mn.join('\n'))].join('\n')+'\n'
 return {fixture,mapping,members,regions:coarse,partitionText:coarsePartitionText,faceMap,nativeInputs,materialPayload,history,projection,
  manganese:fine.manganese,counts:{fineRegions:regions.length,regions:coarse.length,neutronCoordinates:7*coarse.length,
   physicalCoordinates:fine.counts.evolvedCoordinates-7*(regions.length-coarse.length),
   physicalWaterOwners:fine.projection.owners.length,finiteTargets:old.targets.length,
   internalPanels:faces.filter(f=>f.law.kind==='internal-optical').length,faces:faces.length},
  scope:'ORIGINAL seated cold core and closed head; empty receiving bays with uniform scalar flux per higher slab. All material/history owners retained. No loaded racks, fuel movement, local pool observation or directional panel credit.',
  noWholePlantReadinessCredit:true as const}
}

/** A failed reached state remains failed. Only receiving neutron counts and
 * their supplied slopes are summed; C, targets, histories and L are copied.
 * This is a fixed-stage probe, never an initializer or conservation repair. */
export function projectSourceCheckpoint(bytes:Uint8Array,coarse:Pick<ReturnType<typeof compileReceivingResolution>,'mapping'|'counts'>,precursors:number){
 const input=Buffer.from(bytes),oldN=7*coarse.mapping.length,newN=coarse.counts.neutronCoordinates,
  oldCount=coarse.counts.physicalCoordinates+4+oldN-newN,newCount=coarse.counts.physicalCoordinates+4
 if(!Number.isSafeInteger(precursors)||precursors<0||oldN+precursors>oldCount-4
  ||input.length!==33+16*oldCount||input.subarray(0,9).toString()!=='LDSOURCE1'||input.readBigUInt64LE(9)!==BigInt(oldCount))throw Error('Wrong physical checkpoint format or dimensions')
 const output=Buffer.alloc(33+16*newCount);input.copy(output,0,0,33);output.writeBigUInt64LE(BigInt(newCount),9)
 const time=input.readDoubleLE(17),rtol=input.readDoubleLE(25)
 if(!Number.isFinite(time)||time<0||!Number.isFinite(rtol)||rtol<=0)throw Error('Invalid checkpoint time or relative tolerance')
 const drifts:{kind:string,before:number,after:number,difference:number,roundoffScale:number}[]=[]
 for(let which=0;which<2;which++){
  const old=Array.from({length:oldCount},(_,i)=>input.readDoubleLE(33+8*(which*oldCount+i))),next=Array<number>(newCount).fill(0)
  if(old.some(x=>!Number.isFinite(x)))throw Error('Nonfinite physical checkpoint')
  for(let r=0;r<coarse.mapping.length;r++){
   const c=coarse.mapping[r]!
   if(!Number.isSafeInteger(c)||c<0||7*c>=newN)throw Error('Invalid receiving checkpoint map')
   for(let g=0;g<7;g++)next[7*c+g]!+=old[7*r+g]!
  }
  for(let i=oldN;i<oldCount;i++)next[newN+i-oldN]=old[i]!
  if(next.some(x=>!Number.isFinite(x)))throw Error('Nonfinite projected physical checkpoint')
  const before=old.slice(0,oldN+precursors).reduce((s,v)=>s+v,0)-old[oldCount-4]!,
   after=next.slice(0,newN+precursors).reduce((s,v)=>s+v,0)-next[newCount-4]!,
   scale=old.slice(0,oldN+precursors).reduce((s,v)=>s+Math.abs(v),0)+Math.abs(old[oldCount-4]!),difference=after-before
  if(Math.abs(difference)>256*Number.EPSILON*scale)throw Error('Checkpoint projection changed the independent number defect')
  drifts.push({kind:which===0?'physical-state':'supplied-slope',before,after,difference,roundoffScale:scale})
  next.forEach((v,i)=>output.writeDoubleLE(v,33+8*(which*newCount+i)))
 }
 return {bytes:output,time,rtol,drifts,noAdvancement:true as const,noConservationRepair:true as const}
}

/** One immutable preparation, with exact current owner recompilation. This
 * neither runs a solver nor admits the changed spatial approximation. */
export async function prepareReceivingSource(partition:string,material:string,water:string,property:string,wiki:string,state:string,output:string){
 if(await Bun.file(output).exists())throw Error('Refusing to overwrite existing preparation')
 const began=performance.now(),paths=[partition,material,water,property,property+'.artifacts/material.json',state,
  ...sourceEvolutionOwnerFiles.map(p=>join(wiki,p))].map(p=>resolve(p)),
  inputs=await Promise.all(paths.map(async path=>({path,bytes:await readFile(path)}))),
  text=(i:number)=>inputs[i]!.bytes.toString(),parent=JSON.parse(text(3)),payload=JSON.parse(text(4)),
  sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
 if(parent.passed!==true||parent.artifacts?.directory!==resolve(property)+'.artifacts'
  ||!parent.consumed?.some((q:{path:string,sha256:string})=>q.path===paths[2]&&q.sha256===sha(text(2))))throw Error('Unadmitted or different receiving property parent')
 const fine=compileSourceEvolution(text(0),text(1),text(2),new Map(sourceEvolutionOwnerFiles.map((p,i)=>[p,text(i+6)])),payload.receiving.property)
 if(sha(fine.material.fixture)!==parent.fixtureSHA256)throw Error('Current physical material differs from admitted parent')
 const coarse=compileReceivingResolution(fine,text(0)),projected=projectSourceCheckpoint(inputs[5]!.bytes,coarse,fine.history.counts.precursorCoordinates),
  helpers=await sourceHelperFiles([import.meta.path]),directory=resolve(output)+'.artifacts'
 await mkdir(directory)
 await writeFile(join(directory,'input.txt'),coarse.fixture,{flag:'wx'})
 await writeFile(join(directory,'captured.state'),projected.bytes,{flag:'wx'})
 await writeFile(join(directory,'geometry.json'),JSON.stringify({regions:coarse.regions,mapping:coarse.mapping,faceMap:coarse.faceMap})+'\n',{flag:'wx'})
 await Promise.all([...inputs,...[...helpers].map(([path,bytes])=>({path,bytes:Buffer.from(bytes)}))].map((q,i)=>writeFile(join(directory,`${i}-${basename(q.path)}`),q.bytes,{flag:'wx'})))
 const unchanged=(await Promise.all([...inputs,...[...helpers].map(([path,bytes])=>({path,bytes}))].map(async q=>sha(await readFile(q.path))===sha(q.bytes)))).every(Boolean),
  receipt={passed:unchanged,recordedAt:new Date().toISOString(),preparationSeconds:(performance.now()-began)/1000,
   counts:coarse.counts,scope:coarse.scope,projected:{time:projected.time,rtol:projected.rtol,drifts:projected.drifts,noConservationRepair:true},
   consumed:inputs.map(q=>({path:q.path,sha256:sha(q.bytes)})),sources:[...helpers].map(([path,bytes])=>({path,sha256:sha(bytes)})),
   fixtureSHA256:sha(coarse.fixture),checkpointSHA256:sha(projected.bytes),fineFixtureSHA256:sha(fine.fixture),unchanged,
   artifacts:{directory},noAdvancement:true,noSpatialQualification:true,noWholePlantReadinessCredit:true}
 await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
