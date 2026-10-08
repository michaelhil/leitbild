/** SOURCE-represented PRIMARY ORIGINAL water only. Geometry is not a water
 * stock; this compiler's volumes require the fresh IF97 preparation below. */
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename,join,resolve} from 'node:path'
import {compileSourcePartition,diskRectangleArea,type Rectangle} from './reference-design-source-partition'
import {fuelAssemblyPositions,fuelLatticeSites,fuelHandlingChecks} from './reference-design-fuel-handling'
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import {currentColdGeometry} from './reference-design-current-cold-parent'
import {nativeIf97HeaderSha256,nativeIf97LicenseSha256,nativeIf97Source} from './reference-design-if97-primitives'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling} from './reference-design-fuel-handling'
import {parseControlAbsorber} from './reference-design-control-absorber'
import {parseTransferAttachment,parseTransferGates} from './reference-design-fuel-transfer'
import {parseHeadPool} from './reference-design-head-pool'
import {parseCurrentColdParent} from './reference-design-current-cold-parent'
import {parsePrimaryBarrelGeometry,parsePrimaryMechanics} from './reference-design-primary-mechanics'
import {parseInitializationBasis} from './reference-design-initialization'
import {parseSourcePartition} from './reference-design-source-partition'
import {parseColdPressure} from './reference-design-cold-pressure'
import {parseChemistryLifecycle} from './reference-design-chemistry-lifecycle'

type Base=Parameters<typeof compileSourcePartition>[0]
type Input=Base&{attachment:Parameters<typeof currentColdGeometry>[1],gates:Parameters<typeof currentColdGeometry>[4],
 head:Parameters<typeof currentColdGeometry>[5],cold:Parameters<typeof currentColdGeometry>[6],
 anchor:{pressure_Pa:number,temperature_K:number,elevation_m:number},chemistry:{initialPrimary_ppm:number,isotopeFraction:number,
 isotope10MolarMass_kg_mol:number,isotope11MolarMass_kg_mol:number,avogadro_mol:number}}
export type WaterPiece={owner:string,kind:'HS'|'mixed-LOWER',lo_m:number,hi_m:number,volume_m3:number,
 sourceRegionId?:string,datum_m?:number}
const sum=(x:readonly number[])=>x.reduce((a,b)=>a+b,0),sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
const close=(a:number,b:number,what:string,contributingScale=Math.abs(b))=>{
 if(!Number.isFinite(a+b+contributingScale)||Math.abs(a-b)>3e-11*Math.max(contributingScale,1e-12))throw Error('Water support closure: '+what)
}
const circle=(b:Rectangle,x:number,y:number,r:number)=>diskRectangleArea(r,{x0:b.x0-x,x1:b.x1-x,y0:b.y0-y,y1:b.y1-y})
const overlap=(a:number,b:number,c:number,d:number)=>Math.max(0,Math.min(b,d)-Math.max(a,c))
export const originalWaterMassRelativeScreen=2e-8
export function compilePrimaryWaterGeometry(partition:ReturnType<typeof compileSourcePartition>,d:Input){
 const {fuel:f,handling:h,control:c,primary:p,barrel,initialization:i}=d,
  fg=fuelHandlingChecks(h,f).freshGeometry,cg=controlAbsorberGeometry(c,f,h),
  current=currentColdGeometry(c,d.attachment,f,h,d.gates,d.head,d.cold),
  expected=compileSourcePartition(d)
 if(sha(JSON.stringify(partition))!==sha(JSON.stringify(expected)))throw Error('Water/source partition lineage mismatch')
 if(d.cold.primaryAbsorberRatio!==.002||d.chemistry.initialPrimary_ppm*1e-6!==d.cold.primaryAbsorberRatio
  ||d.anchor.temperature_K!==300||d.anchor.pressure_Pa!==300000||d.anchor.elevation_m!==2.5)
  throw Error('This component consumes only the selected ORIGINAL cold2000 datum')
 const pieces:WaterPiece[]=[],active=partition.regions.filter(r=>r.compartment==='ACTIVE'),
  wetBore=fg.guideInnerArea_m2-fg.sourceArea_m2,
  rodR=f.rodOuterDiameter_m/2,go=f.guideOuterDiameter_m/2,gi=h.guideInnerDiameter_m/2,
  pins=fuelLatticeSites(f),assemblies=fuelAssemblyPositions(h,f),bodyRadius=c.bodyDiameter_m/2,
  cluster=new Set(cg.sites.map(s=>`${s.x_m}/${s.y_m}`)),bodyLo=c.insertedBodyBottom_m,bodyHi=bodyLo+c.bodyLength_m
 const halfPitch=f.latticeSide*f.pitch_m/2
 if(assemblies.some(fa=>Math.hypot(Math.abs(fa.x_m)+halfPitch,Math.abs(fa.y_m)+halfPitch)>=barrel.innerRadius_m))
  throw Error('Actual FA water support crosses the solid barrel')
 const add=(q:WaterPiece)=>{
  if(!Number.isFinite(q.volume_m3+q.lo_m+q.hi_m)||q.volume_m3<0||q.hi_m<q.lo_m
   ||(q.kind==='HS'&&q.hi_m===q.lo_m))throw Error('Invalid primary water support')
  if(q.volume_m3>0)pieces.push(q)
 }
 const cuts=(lo:number,hi:number,extra:readonly number[])=>[...new Set([lo,hi,...extra.filter(z=>z>lo&&z<hi)])].sort((a,b)=>a-b)
 const activeBase={external:0,bore:0,down:0}
 for(const r of active){
  const b=r.box!,z0=r.z0_m!,z1=r.z1_m!,zs=cuts(z0,z1,[0,bodyLo,bodyHi])
  let externalArea=0,boreArea=0,bodyArea=0
  for(const fa of assemblies){
   const pitch=f.latticeSide*f.pitch_m,box={x0:fa.x_m-pitch/2,x1:fa.x_m+pitch/2,y0:fa.y_m-pitch/2,y1:fa.y_m+pitch/2},
    area=overlap(box.x0,box.x1,b.x0,b.x1)*overlap(box.y0,box.y1,b.y0,b.y1)
   if(area===0)continue
   const rod=sum(pins.filter(q=>!q.guide).map(q=>circle(b,fa.x_m+q.x,fa.y_m+q.y,rodR))),
    outer=sum(pins.filter(q=>q.guide).map(q=>circle(b,fa.x_m+q.x,fa.y_m+q.y,go))),
    bore=sum(pins.filter(q=>q.guide).map(q=>circle(b,fa.x_m+q.x,fa.y_m+q.y,gi)))
   externalArea+=area-rod-outer;boreArea+=bore
   if(cluster.has(`${fa.x_m}/${fa.y_m}`))bodyArea+=sum(cg.bodySites.map(q=>circle(b,fa.x_m+q.x_m,fa.y_m+q.y_m,bodyRadius)))
  }
  // The one actual thimble occupies the central guide, never extra moderator.
  boreArea-=circle(b,0,0,h.sourceThimbleDiameter_m/2)
  const downArea=diskRectangleArea(r.diskRadius_m!,b)-diskRectangleArea(barrel.outerRadius_m,b)
  for(let n=1;n<zs.length;n++){
   const lo=zs[n-1]!,hi=zs[n]!,body=(lo+hi)/2>bodyLo&&(lo+hi)/2<bodyHi?bodyArea:0,
    half=(lo+hi)/2<0?'1':'2'
   add({owner:`Core.${half}.EXTERNAL`,kind:'HS',lo_m:lo,hi_m:hi,volume_m3:externalArea*(hi-lo),sourceRegionId:r.id})
   add({owner:`Core.${half}.GUIDE`,kind:'HS',lo_m:lo,hi_m:hi,volume_m3:(boreArea-body)*(hi-lo),sourceRegionId:r.id})
   add({owner:'DOWN',kind:'HS',lo_m:lo,hi_m:hi,volume_m3:downArea*(hi-lo),sourceRegionId:r.id})
  }
  activeBase.external+=externalArea*(z1-z0);activeBase.bore+=boreArea*(z1-z0);activeBase.down+=downArea*(z1-z0)
 }
 close(activeBase.external,fg.active.externalFreeVolume_m3,'FA exterior, no peripheral water')
 close(activeBase.bore,fg.active.boreVolume_m3,'guide/thimble support')
 const downA=i.volumes_m3[0]!/(p.downcomerTop_m-p.downcomerBottom_m),activeLo=-2,activeHi=2
 close(activeBase.down,downA*(activeHi-activeLo),'represented actual DOWN intersection')
 add({owner:'DOWN',kind:'HS',lo_m:p.downcomerBottom_m,hi_m:activeLo,volume_m3:downA*(activeLo-p.downcomerBottom_m)})
 add({owner:'DOWN',kind:'HS',lo_m:activeHi,hi_m:p.downcomerTop_m,volume_m3:downA*(p.downcomerTop_m-activeHi)})
 // These equipment source nodes consume owned reduced volumes, not invented cylinders.
 add({owner:'LOWER.EXTERNAL',kind:'mixed-LOWER',lo_m:-3,hi_m:-3,datum_m:-3,
  volume_m3:fg.lower.externalFreeVolume_m3,sourceRegionId:'LOWER'})
 const guide=(owner:string,lo:number,hi:number,region:string)=>{
  const zs=cuts(lo,hi,[bodyLo,bodyHi]);for(let n=1;n<zs.length;n++){
   const a=zs[n-1]!,b=zs[n]!,mid=(a+b)/2,A=wetBore-(mid>bodyLo&&mid<bodyHi?current.bodyArea_m2:0)
   add({owner,kind:'HS',lo_m:a,hi_m:b,volume_m3:A*(b-a),sourceRegionId:region})
  }
 }
 guide('LOWER.GUIDE',fg.lower.boreBottom_m,fg.lower.boreTop_m,'LOWER')
 guide('UPPER.GUIDE',fg.upper.boreBottom_m,current.faTop_m,'UPPER')
 const upper=[{lo:2,hi:2+f.plenumLength_m,area:i.volumes_m3[4]!/2-fg.guideOuterArea_m2-fg.upper.sealedRodPlenumDisplacement_m3/f.plenumLength_m},
  {lo:2+f.plenumLength_m,hi:current.faTop_m,area:i.volumes_m3[4]!/2-fg.guideOuterArea_m2-fg.upper.fittingDisplacement_m3/(current.faTop_m-2-f.plenumLength_m)},
  {lo:current.faTop_m,hi:h.sourceThimbleTop_m,area:i.volumes_m3[4]!/2-fg.sourceArea_m2},
  {lo:h.sourceThimbleTop_m,hi:4,area:i.volumes_m3[4]!/2}],intruders=current.intruders.filter(q=>q.shape!=='rodlet')
 for(const q of upper){const zs=cuts(q.lo,q.hi,intruders.flatMap(x=>[x.lo,x.hi]));for(let n=1;n<zs.length;n++){
  const a=zs[n-1]!,b=zs[n]!,mid=(a+b)/2,A=q.area-sum(intruders.filter(x=>mid>x.lo&&mid<x.hi).map(x=>x.area))
  add({owner:'UPPER.EXTERNAL',kind:'HS',lo_m:a,hi_m:b,volume_m3:A*(b-a),sourceRegionId:'UPPER'})
 }}
 const collarRows=current.housing.collarBottoms.map(lo=>({lo,hi:lo+current.housing.collarHeight,area:current.housing.collarArea}))
 for(const [name,lo,hi,radius] of [['MAIN',current.housing.mainLo,current.housing.mainHi,c.housingID_m/2],
  ['NECK',current.housing.mainHi,current.housing.neckHi,c.neckID_m/2]] as const){
  const objects=name==='NECK'?[...current.intruders,...collarRows]:current.intruders,
   zs=cuts(lo,hi,[...objects.flatMap(q=>[q.lo,q.hi]),...partition.regions.filter(r=>r.compartment==='WELL').flatMap(r=>[r.z0_m!,r.z1_m!])])
  for(let n=1;n<zs.length;n++){
   const a=zs[n-1]!,b=zs[n]!,mid=(a+b)/2,stem=objects.filter(q=>mid>q.lo&&mid<q.hi),
    removedA=sum(stem.map(q=>q.area))/c.clusters,
    fullA=Math.PI*radius**2-removedA
   if(!(fullA>0))throw Error('Nonpositive actual housing support')
   for(const site of cg.sites){let represented=0
    for(const r of partition.regions.filter(r=>r.compartment==='WELL'&&r.z0_m!<=a&&r.z1_m!>=b)){
     // All admitted housing intruders here are centered stems or concentric collars.
     const base=circle(r.box!,site.x_m,site.y_m,radius),
      collarPresent=name==='NECK'&&collarRows.some(q=>mid>q.lo&&mid<q.hi),
      removed=sum(current.intruders.map(q=>q.shape==='annulus'&&mid>q.lo&&mid<q.hi
       ?circle(r.box!,site.x_m,site.y_m,q.outer_m)-(q.inner_m===0?0:circle(r.box!,site.x_m,site.y_m,q.inner_m)):0))
       +(collarPresent?circle(r.box!,site.x_m,site.y_m,c.collarOD_m/2)-circle(r.box!,site.x_m,site.y_m,c.collarID_m/2):0),
      area=base-removed
     if(area< -1e-15)throw Error('Housing intersection lost positivity')
     if(area>0){add({owner:`HOUSING.${name}`,kind:'HS',lo_m:a,hi_m:b,volume_m3:area*(b-a),sourceRegionId:r.id});represented+=area}
    }
    close(represented,fullA,'housing free support in WELL source')
   }
  }
 }
 // Physical volumes are not rebalanced to match historical native receipts.
 close(sum(pieces.filter(q=>q.owner==='DOWN').map(q=>q.volume_m3)),i.volumes_m3[0]!,'whole DOWN')
 const molar=d.chemistry.isotopeFraction*d.chemistry.isotope10MolarMass_kg_mol
  +(1-d.chemistry.isotopeFraction)*d.chemistry.isotope11MolarMass_kg_mol,
  atomsPerMarker=d.chemistry.avogadro_mol*d.chemistry.isotopeFraction/molar
 if(!(atomsPerMarker>0&&Number.isFinite(atomsPerMarker)))throw Error('Invalid actual isotope seed')
 const minimumHSSpan_m=Math.min(...pieces.filter(q=>q.kind==='HS').map(q=>q.hi_m-q.lo_m))
 return {preparation:'ORIGINAL cold2000 IF97 primary source support',anchor:d.anchor,pieces,atomsPerMarker,minimumHSSpan_m,
  avogadro:d.chemistry.avogadro_mol,markerRatio:d.cold.primaryAbsorberRatio,
  scope:'SOURCE-represented primary water only; DOWN ends explicitly outside source. No bay water, packing-gap water, imported HEOS stocks, full primary appendages, full operator or calibration.'}
}

// Fixed eight-point Gauss rule; comparisons below retain the independent full
// support and split-rule discrepancy rather than normalizing a missing stock.
const nodes=[-.9602898564975363,-.7966664774136267,-.525532409916329,-.1834346424956498,.1834346424956498,.525532409916329,.7966664774136267,.9602898564975363],
 weights=[.1012285362903763,.2223810344533745,.3137066458778873,.362683783378362,.362683783378362,.3137066458778873,.2223810344533745,.1012285362903763]
export function waterPreparationPoints(g:ReturnType<typeof compilePrimaryWaterGeometry>){
 return g.pieces.flatMap((q,piece)=>q.kind==='mixed-LOWER'?[{piece,kind:1,z:q.datum_m!,volume:q.volume_m3}]:
  nodes.map((x,n)=>({piece,kind:0,z:(q.lo_m+q.hi_m)/2+(q.hi_m-q.lo_m)/2*x,volume:q.volume_m3*weights[n]!/2})))
}
export function assembleOriginalWater(g:ReturnType<typeof compilePrimaryWaterGeometry>,samples:{density_kg_m3:number,u_J_kg:number,pressure_Pa:number,temperature_K:number,h_J_kg:number,s_J_kg_K:number}[]){
 const points=waterPreparationPoints(g)
 if(points.length!==samples.length)throw Error('Prepared point coverage mismatch')
 type Amount={volume_m3:number,water_kg:number,U_J:number,PE_J:number,mobileMarker_kg_eq:number,mobileN10:number,Htarget:number,retainedMarker_kg_eq:number,retainedN10:number,HcaptureProduct:number}
 const empty=():Amount=>({volume_m3:0,water_kg:0,U_J:0,PE_J:0,mobileMarker_kg_eq:0,mobileN10:0,Htarget:0,retainedMarker_kg_eq:0,retainedN10:0,HcaptureProduct:0}),
  owners=new Map<string,{owner:string,total:Amount,represented:Amount,outsideSource:Amount}>(),absolute=new Map<string,Amount>(),
  incidence=new Map<string,{owner:string,sourceRegionId:string,amount:Amount}>()
 points.forEach((point,n)=>{
  const p=samples[n]!,q=g.pieces[point.piece]!,M=p.density_kg_m3*point.volume,
   a:Amount={...empty(),volume_m3:point.volume,water_kg:M,U_J:M*p.u_J_kg,PE_J:M*9.80665*point.z,
    mobileMarker_kg_eq:M*g.markerRatio,mobileN10:M*g.markerRatio*g.atomsPerMarker,Htarget:2*M*g.avogadro/.01801528}
  if(!Object.values(p).every(Number.isFinite)||p.pressure_Pa<=0||p.temperature_K<=0||p.density_kg_m3<=0||M<=0)throw Error('Invalid prepared actual native water')
  let owner=owners.get(q.owner);if(!owner){owner={owner:q.owner,total:empty(),represented:empty(),outsideSource:empty()};owners.set(q.owner,owner);absolute.set(q.owner,empty())}
  for(const k of Object.keys(a) as (keyof Amount)[])absolute.get(q.owner)![k]+=Math.abs(a[k])
  const add=(to:Amount)=>{for(const k of Object.keys(a) as (keyof Amount)[])to[k]+=a[k]}
  add(owner.total);add(q.sourceRegionId?owner.represented:owner.outsideSource)
  if(q.sourceRegionId){const key=q.owner+'|'+q.sourceRegionId;let row=incidence.get(key)
   if(!row){row={owner:q.owner,sourceRegionId:q.sourceRegionId,amount:empty()};incidence.set(key,row)}add(row.amount)}
 })
 for(const owner of owners.values())for(const k of Object.keys(owner.total) as (keyof Amount)[]){
  const actual=sum([...incidence.values()].filter(q=>q.owner===owner.owner).map(q=>q.amount[k]))
  close(actual,owner.represented[k],owner.owner+' represented '+k,absolute.get(owner.owner)![k])
  close(owner.represented[k]+owner.outsideSource[k],owner.total[k],owner.owner+' complete '+k,absolute.get(owner.owner)![k])
 }
 return {component:g.scope,completeReactorOperator:false,preparation:g.preparation,nativeOwners:[...owners.values()],sourceIncidence:[...incidence.values()],
  missingContributions:['receiving native water','primary owners outside this selected apparatus','fixed/retained/body/panel/gate/converter reaction and optical capture','moderator/mobile-absorber rates','regional transport and full operator/calibration'],
  sampledPoints:points.length}
}

export const primaryWaterOwnerFiles=['systems/reactor/fuel-construction.md','systems/reactor/fuel-handling-and-pool.md',
 'systems/reactor/control-absorber-and-guide-water.md','systems/reactor/fuel-transfer-grapple.md',
 'systems/reactor/head-and-pool-cooling.md','model/connected-primary-initialization.md',
 'systems/primary-coolant/mechanical-energy-and-geometry.md','systems/reactor/core-coolant-delivery.md',
 'model/operating-source-model.md','safety/cold-pressure-and-startup-protection.md','systems/primary-coolant/inventory-and-chemistry.md']
export function parsePrimaryWaterInputs(docs:readonly string[]):Input{
 if(docs.length!==primaryWaterOwnerFiles.length)throw Error('Missing physical water owners')
 const pressure=parseColdPressure(docs[9]!)
 return {fuel:parseFuelConstruction(docs[0]!),handling:parseFuelHandling(docs[1]!),control:parseControlAbsorber(docs[2]!),
  attachment:parseTransferAttachment(docs[3]!),gates:parseTransferGates(docs[3]!),head:parseHeadPool(docs[4]!),
  cold:parseCurrentColdParent(docs[5]!),initialization:parseInitializationBasis(docs[5]!),
  primary:parsePrimaryMechanics(docs[6]!),barrel:parsePrimaryBarrelGeometry(docs[7]!),partition:parseSourcePartition(docs[8]!),
  anchor:{temperature_K:pressure.coldPzr.temperature_K,pressure_Pa:pressure.coldPzr.hotPressure_Pa,elevation_m:2.5},
  chemistry:parseChemistryLifecycle(docs[10]!)}
}

/** ONE <=60s original-state point admission; no advancing solve. */
export async function preparePrimarySourceWater(wiki:string,if97:string,output:string,allowanceMs=60000){
 const began=performance.now(),out=resolve(output),inputDir=resolve(if97),root=resolve(import.meta.dir,'../native/process-plant')
 if(!Number.isFinite(allowanceMs)||allowanceMs<=0||allowanceMs>60000)throw Error('Invalid remaining original preparation allowance')
 try{await readFile(out);throw Error('Receipt exists; refusing overwrite')}
 catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error}
 const paths=primaryWaterOwnerFiles.map(f=>join(resolve(wiki),f)),docs=await Promise.all(paths.map(f=>readFile(f,'utf8'))),
  inputs=parsePrimaryWaterInputs(docs),partition=compileSourcePartition(inputs),geometry=compilePrimaryWaterGeometry(partition,inputs),
  points=waterPreparationPoints(geometry),ends=geometry.pieces.flatMap((p,piece)=>p.kind==='HS'?[{piece,z:p.lo_m},{piece,z:p.hi_m}]:[]),
  fixture=[geometry.anchor.pressure_Pa,geometry.anchor.temperature_K,geometry.anchor.elevation_m,geometry.minimumHSSpan_m,originalWaterMassRelativeScreen,points.length+ends.length,
   ...points.flatMap(q=>[q.kind,q.z]),...ends.flatMap(q=>[0,q.z])].join('\n')+'\n',
  scratch=await mkdtemp(join(tmpdir(),'ld01-source-water-')),artifacts=out+'.artifacts'
 await mkdir(artifacts)
 const helperNames=['reference-design-source-water.ts','reference-design-source-partition.ts','reference-design-source-material.ts',
  'reference-design-fuel-handling.ts','reference-design-fuel-construction.ts','reference-design-control-absorber.ts',
  'reference-design-fuel-transfer.ts','reference-design-current-cold-parent.ts','reference-design-primary-mechanics.ts',
  'reference-design-initialization.ts','reference-design-cold-pressure.ts','reference-design-chemistry-lifecycle.ts',
  'reference-design-head-pool.ts','reference-design-if97-primitives.ts'],
  sources=[...helperNames.map(f=>join(import.meta.dir,f)),...['Cargo.toml','Cargo.lock','build.rs','src/lib.rs','src/original_water.rs','src/mixing.rs','src/fuel_source.rs','src/if97-bridge.cpp','examples/source-water.rs'].map(f=>join(root,f))],
  sourceTexts=await Promise.all(sources.map(p=>readFile(p))),
  header=await readFile(join(inputDir,'IF97.h')),license=await readFile(join(inputDir,'LICENSE'))
 if(sha(header)!==nativeIf97HeaderSha256||sha(license)!==nativeIf97LicenseSha256)throw Error('Pinned property source identity mismatch')
 await Promise.all(sources.map((p,n)=>writeFile(join(artifacts,`${n}-${basename(p)}`),sourceTexts[n]!,{flag:'wx'})))
 await writeFile(join(artifacts,'point-input.txt'),fixture,{flag:'wx'})
 await writeFile(join(scratch,'if97-bridge.cpp'),nativeIf97Source(true)+'\n'+await readFile(join(root,'src/if97-bridge.cpp'),'utf8'),{flag:'wx'})
 const env={...process.env,LEITBILD_IF97_DIR:inputDir,LEITBILD_IF97_BRIDGE_DIR:scratch,CARGO_TARGET_DIR:join(scratch,'target')}
 async function execute(command:string[],stdin?:string){
  const remaining=allowanceMs-(performance.now()-began)
  if(remaining<=0)return {command,stdout:'',stderr:'Aggregate original preparation allowance exhausted',exitCode:null,timedOut:true}
  const child=Bun.spawn(command,{env,stdin:stdin?new Blob([stdin]):undefined,stdout:'pipe',stderr:'pipe'});let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill()},remaining)
  const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  return {command,stdout,stderr,exitCode,timedOut}
 }
 const version=await execute(['rustc','--version']),build=version.exitCode===0&&!version.timedOut?
  await execute(['cargo','build','--release','--example','source-water','--manifest-path',join(root,'Cargo.toml')]):null,
  binary=join(scratch,'target/release/examples/source-water'),run=build?.exitCode===0&&!build.timedOut?await execute([binary],fixture):null
 let result:ReturnType<typeof assembleOriginalWater>|null=null,checks:unknown[]=[],verificationError:string|null=null
 if(run){await writeFile(join(artifacts,'point-output.ndjson'),run.stdout,{flag:'wx'});await writeFile(join(artifacts,'source-water-binary'),await readFile(binary),{flag:'wx'})}
 if(run?.exitCode===0&&!run.timedOut){
  try {
  const rows=run.stdout.trim().split('\n').map(line=>JSON.parse(line)),datum=rows.shift()
  result=assembleOriginalWater(geometry,rows.slice(0,points.length))
  const maxHS=points.reduce((acc,q,n)=>q.kind===1?acc:Math.max(acc,Math.abs(rows[n].h_J_kg+9.80665*q.z-datum.H_J_kg)),0),
   maxS=points.reduce((acc,q,n)=>q.kind===1?acc:Math.max(acc,Math.abs(rows[n].s_J_kg_K-datum.entropy_J_kg_K)),0)
  if(maxHS>3e-7||maxS>3e-10)throw Error('Independent original H/S residual admission failed')
  let worstHydroMass=0
  for(let n=0;n<ends.length;n+=2){const q=geometry.pieces[ends[n]!.piece]!,A=q.volume_m3/(q.hi_m-q.lo_m),
   analytic=A*(rows[points.length+n].pressure_Pa-rows[points.length+n+1].pressure_Pa)/9.80665,
   quadrature=sum(points.flatMap((p,k)=>p.piece===ends[n]!.piece?[p.volume*rows[k].density_kg_m3]:[])),
   relative=Math.abs(analytic-quadrature)/quadrature
   worstHydroMass=Math.max(worstHydroMass,relative)
   // Finite preparation quadrature screen, not a blanket operating pressure budget.
   if(relative>originalWaterMassRelativeScreen)throw Error('Independent hydrostatic native-mass identity failed')
  }
  checks=[{name:'actual same-property H/S preparation',maxEnthalpy_J_kg:maxHS,maxEntropy_J_kg_K:maxS},
   {name:'independent dp/dz mass integral versus volume quadrature',maximumRelativeDiscrepancy:worstHydroMass},
   {name:'positive native/source stock and outside-domain closure',owners:result.nativeOwners.length,rows:result.sourceIncidence.length}]
  } catch(error){result=null;verificationError=error instanceof Error?error.message:String(error)}
 }
 const unchanged=(await Promise.all(paths.map(p=>readFile(p,'utf8')))).every((s,n)=>s===docs[n])
  &&(await Promise.all(sources.map(p=>readFile(p)))).every((s,n)=>sha(s)===sha(sourceTexts[n]!))
  &&sha(await readFile(join(inputDir,'IF97.h')))===sha(header)&&sha(await readFile(join(inputDir,'LICENSE')))===sha(license),
  elapsedSeconds=(performance.now()-began)/1000
 const receipt={recordedAt:new Date().toISOString(),passed:!!result&&unchanged&&elapsedSeconds<=allowanceMs/1000,allowanceSeconds:allowanceMs/1000,elapsedSeconds,
  consumed:paths.map((path,n)=>({path,sha256:sha(docs[n]!)})),sourceIdentities:sources.map((path,n)=>({path,sha256:sha(sourceTexts[n]!)})),
  upstream:{header:nativeIf97HeaderSha256,license:nativeIf97LicenseSha256},fixtureSHA256:sha(fixture),
  binarySHA256:run?sha(await readFile(binary)):null,partitionSHA256:sha(JSON.stringify(partition)),inputs,geometry,result,checks,verificationError,
  version,build,run:run?{...run,stdout:'Retained as actual per-point result in point-output.ndjson'}:null,unchanged,
  scope:'Finite ORIGINAL preparation/native source incidence only. No material-rate/operator/calibration/trajectory/real-time claim.'}
 await writeFile(out,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
 return receipt
}
if(import.meta.main){const [wiki,if97,output,...rest]=Bun.argv.slice(2)
 if(!wiki||!if97||!output||rest.length)throw Error('Usage: source-water <LD01 wiki> <pinned IF97 directory> <NEW receipt>')
 const r=await preparePrimarySourceWater(wiki,if97,output);console.log(JSON.stringify({passed:r.passed,elapsedSeconds:r.elapsedSeconds,receipt:output}));if(!r.passed)process.exitCode=1}
