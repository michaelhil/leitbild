/** Cold ORIGINAL FA/thermal/converter incidence only. No nuclear coefficients,
 * native moderator projection, source advancement or operating qualification. */
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'
import {fuelGeometry,parseFuelConstruction} from './reference-design-fuel-construction'
import {fuelAssemblyPositions,fuelHandlingChecks,fuelLatticeSites,parseFuelHandling} from './reference-design-fuel-handling'
import {parseControlAbsorber} from './reference-design-control-absorber'
import {parsePrimaryBarrelGeometry,parsePrimaryMechanics} from './reference-design-primary-mechanics'
import {parseInitializationBasis} from './reference-design-initialization'
import {parseColdNuclear} from './reference-design-cold-nuclear'
import {nuclearObservationGeometry,parseNuclearObservation} from './reference-design-nuclear-observation'
import {compileSourcePartition,diskRectangleArea,parseSourcePartition,type Rectangle,type SourceRegion} from './reference-design-source-partition'
import {circleRectangleArcs} from './reference-design-source-faces'

const gridSchema=z.object({axialBands:z.number().int().positive().refine(n=>n%2===0,'Two material-history segments require whole thermal bands'),
 fuelIntervals:z.number().int().positive(),cladIntervals:z.number().int().positive()}).strict()
export function parseOperatingFuelCohorts(document:string){
 const blocks=[...document.matchAll(/^```reference-operating-fuel-cohorts\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one reference-operating-fuel-cohorts block')
 return gridSchema.parse(JSON.parse(blocks[0]![1]!))
}
/** Existing radial-owner rule: nodes include physical surfaces; halfway faces
 * give those nodes finite mass. These are reference coordinates, not hot radii. */
export function radialCohorts(inner:number,outer:number,intervals:number){
 if(!Number.isFinite(inner+outer)||inner<0||outer<=inner||!Number.isInteger(intervals)||intervals<1)
  throw Error('Invalid radial material support')
 const nodes=Array.from({length:intervals+1},(_,i)=>inner+(outer-inner)*i/intervals)
 return nodes.map((radius_m,i)=>{const inner_m=i===0?inner:(nodes[i-1]!+radius_m)/2,
  outer_m=i===intervals?outer:(radius_m+nodes[i+1]!)/2
  return {node:i,radius_m,inner_m,outer_m,massFraction:(outer_m**2-inner_m**2)/(outer**2-inner**2)}
 })
}
type Partition=Pick<ReturnType<typeof compileSourcePartition>,'regions'|'assemblies'>
type Inputs={fuel:ReturnType<typeof parseFuelConstruction>,handling:ReturnType<typeof parseFuelHandling>,
 grid:ReturnType<typeof parseOperatingFuelCohorts>,apparatus:ReturnType<typeof parseNuclearObservation>,
 source:Pick<ReturnType<typeof parseColdNuclear>['source'],'birthEmission_neutrons_s'>}
type Cohort={id:string,faId:string,segmentId:string,band:number,material:'fuel'|'clad',node:number,
 z0_m:number,z1_m:number,radius_m:number,inner_m:number,outer_m:number,referenceMass_kg:number,original_K:number,originalSensibleEnergy_J:number,mu?:number}
type MaterialIncidence={stockId:string,faId:string,kind:'rod-composite'|'guide-metal'|'guide-bore-support'|'external-water-support'|'plenum-clad'|'plenum-sealed-space-support'|'bottom-fitting'|'top-fitting',
 sourceRegionId:string,volume_m3:number,referenceMass_kg?:number}
type HeatIncidence={cohortId:string,segmentId:string,sourceRegionId:string,W_kg:number,eta:number}
const overlap=(a:number,b:number,c:number,d:number)=>Math.max(0,Math.min(b,d)-Math.max(a,c))
const sum=(xs:readonly number[])=>xs.reduce((a,b)=>a+b,0)
const close=(actual:number,expected:number,name:string)=>{
 if(!Number.isFinite(actual+expected)||Math.abs(actual-expected)>2e-11*Math.max(Math.abs(expected),1e-12))
  throw Error('Incomplete/duplicated material support: '+name)
}
const areaIn=(box:Rectangle,x:number,y:number,r:number)=>{
 if(r===0)return 0
 if(box.x0<=x-r&&box.x1>=x+r&&box.y0<=y-r&&box.y1>=y+r)return Math.PI*r*r
 if(box.x0>=x+r||box.x1<=x-r||box.y0>=y+r||box.y1<=y-r)return 0
 return diskRectangleArea(r,{x0:box.x0-x,x1:box.x1-x,y0:box.y0-y,y1:box.y1-y})
}
export function compileColdSourceMaterial(partition:Partition,input:Inputs){
 const {fuel:f,handling:h,grid:rawGrid,apparatus:n}=input,grid=gridSchema.parse(rawGrid),
  expectedFA=fuelAssemblyPositions(h,f),regions=partition.regions,
  active=regions.filter(r=>r.compartment==='ACTIVE'),lower=regions.filter(r=>r.compartment==='LOWER'),upper=regions.filter(r=>r.compartment==='UPPER')
 if(f.referenceTemperature_K!==300||n.original_K!==300)throw Error('Cold incidence requires the owned300K original preparation')
 const faMismatch=partition.assemblies.length!==expectedFA.length||expectedFA.some((fa,i)=>{
  const actual=partition.assemblies[i];return !actual||actual.id!==fa.id||actual.x_m!==fa.x_m||actual.y_m!==fa.y_m
 })
 if(faMismatch||new Set(regions.map(r=>r.id)).size!==regions.length
  ||lower.length!==1||upper.length!==1)throw Error('Inconsistent immutable FA/source identities')
 if(active.some(r=>!r.box||!Number.isFinite(r.z0_m)||!Number.isFinite(r.z1_m)||r.z1_m!<=r.z0_m!))
  throw Error('Invalid literal active source support')
 const rf=f.pelletDiameter_m/2,ro=f.rodOuterDiameter_m/2,ri=ro-f.cladThickness_m,
  go=f.guideOuterDiameter_m/2,gi=h.guideInnerDiameter_m/2,rhoF=f.fuelDensityFraction*f.fuelTheoreticalDensity_kg_m3,
  rhoC=f.cladDensity_kg_m3,pitch=f.latticeSide*f.pitch_m,activeBottom=h.seatedBottom_m+h.bottomFittingLength_m,
  activeTop=activeBottom+f.activeLength_m,fullTop=activeTop+f.plenumLength_m+h.topFittingLength_m,
  T=f.referenceTemperature_K,fuelShells=radialCohorts(0,rf,grid.fuelIntervals),cladShells=radialCohorts(ri,ro,grid.cladIntervals)
 if(!(rf<ri&&ri<ro&&gi<go&&go<f.pitch_m/2)||f.latticeSide!==17||f.guidesPerAssembly!==25)
  throw Error('Cold rod/guide pattern outside selected construction')
 const pins=fuelLatticeSites(f)
 const rods=pins.filter(p=>!p.guide),guides=pins.filter(p=>p.guide)
 if(rods.length!==f.rodsPerAssembly||guides.length!==f.guidesPerAssembly)throw Error('Unowned rod/guide lattice position')
 const cohorts:Cohort[]=[],segments:{id:string,faId:string,index:number,z0_m:number,z1_m:number,referenceFuelMass_kg:number,referenceCladMass_kg:number}[]=[],
  material:MaterialIncidence[]=[],heat:HeatIncidence[]=[],
  fissionIncidence:{faId:string,segmentId:string,sourceRegionId:string,compositeVolume_m3:number,delayedBirthShare:number}[]=[],
  helium:{faId:string,volume_m3:number,nR_J_K:number,original_K:number,originalInternalEnergy_J:number}[]=[]
 const add=(row:MaterialIncidence)=>{
  if(!Number.isFinite(row.volume_m3)||row.volume_m3<0
   ||(row.referenceMass_kg!==undefined&&(!Number.isFinite(row.referenceMass_kg)||row.referenceMass_kg<0)))
   throw Error('Nonpositive/nonfinite physical material support')
  if(row.volume_m3>0)material.push(row)
 }
 for(const fa of expectedFA){
  const firstMaterial=material.length
  const segmentLength=f.activeLength_m/2,mf=f.rodsPerAssembly*Math.PI*rf**2*segmentLength*rhoF,
   mc=f.rodsPerAssembly*Math.PI*(ro**2-ri**2)*segmentLength*rhoC,
   faSegments=[0,1].map(index=>({id:`${fa.id}/segment/${index}`,faId:fa.id,index,
    z0_m:activeBottom+index*segmentLength,z1_m:activeBottom+(index+1)*segmentLength,referenceFuelMass_kg:mf,referenceCladMass_kg:mc}))
  segments.push(...faSegments)
  const own=cohortFactory(fa.id,faSegments,grid,fuelShells,cladShells,rhoF,rhoC,f.rodsPerAssembly,T)
  cohorts.push(...own)
  const box={x0:fa.x_m-pitch/2,x1:fa.x_m+pitch/2,y0:fa.y_m-pitch/2,y1:fa.y_m+pitch/2},
   candidate=active.filter(r=>r.box!.x1>box.x0&&r.box!.x0<box.x1&&r.box!.y1>box.y0&&r.box!.y0<box.y1),
   plans=new Map<string,{rodArea:number,guideArea:number,boreArea:number,externalArea:number,shellAreas:Map<string,number>}>()
  for(const r of candidate){const b=r.box!,key=JSON.stringify(b)
   if(plans.has(key))continue
   const circles=(ps:typeof pins,radius:number)=>sum(ps.map(p=>areaIn(b,fa.x_m+p.x,fa.y_m+p.y,radius))),
    rodArea=circles(rods,ro),guideOuter=circles(guides,go),boreArea=circles(guides,gi),
    planOverlap=Math.max(0,Math.min(box.x1,b.x1)-Math.max(box.x0,b.x0))*Math.max(0,Math.min(box.y1,b.y1)-Math.max(box.y0,b.y0)),
    shellAreas=new Map<string,number>()
   for(const [material,shells] of [['fuel',fuelShells],['clad',cladShells]] as const)for(const shell of shells)
    shellAreas.set(material+'/'+shell.node,circles(rods,shell.outer_m)-circles(rods,shell.inner_m))
   // Every cold FA envelope lies inside the source circle; a changed crop must
   // fail coverage, not keep the enclosing square's unsupported moderator.
   if(r.diskRadius_m!==undefined&&Math.hypot(Math.abs(fa.x_m)+pitch/2,Math.abs(fa.y_m)+pitch/2)>=r.diskRadius_m)
    throw Error('FA envelope is not covered by literal source disk')
   plans.set(key,{rodArea,guideArea:guideOuter-boreArea,boreArea,externalArea:planOverlap-rodArea-guideOuter,shellAreas})
  }
  for(const r of candidate){const p=plans.get(JSON.stringify(r.box))!,length=overlap(activeBottom,activeTop,r.z0_m!,r.z1_m!)
   if(length===0)continue
   for(const [kind,area] of [['rod-composite',p.rodArea],['guide-metal',p.guideArea],['guide-bore-support',p.boreArea],['external-water-support',p.externalArea]] as const)
    add({stockId:`${fa.id}/${kind}`,faId:fa.id,kind,sourceRegionId:r.id,volume_m3:area*length,...(kind==='guide-metal'?{referenceMass_kg:area*length*rhoC}:{})})
   for(const s of faSegments){const dz=overlap(s.z0_m,s.z1_m,r.z0_m!,r.z1_m!)
    if(dz>0&&p.rodArea>0)fissionIncidence.push({faId:fa.id,segmentId:s.id,sourceRegionId:r.id,
     compositeVolume_m3:p.rodArea*dz,delayedBirthShare:p.rodArea*dz/(f.rodsPerAssembly*Math.PI*ro**2*segmentLength)})
   }
   for(const q of own.filter(q=>q.material==='fuel')){const dz=overlap(q.z0_m,q.z1_m,r.z0_m!,r.z1_m!),W=p.shellAreas.get('fuel/'+q.node)!*dz*rhoF
    if(W>0)heat.push({cohortId:q.id,segmentId:q.segmentId,sourceRegionId:r.id,W_kg:W,eta:0})
   }
  }
  const fullGuideArea=f.guidesPerAssembly*Math.PI*(go**2-gi**2),
   boreArea=f.guidesPerAssembly*Math.PI*gi**2
  for(const [r,z0,z1] of [[lower[0]!,h.seatedBottom_m,activeBottom],[upper[0]!,activeTop,fullTop]] as const){
   add({stockId:`${fa.id}/guide-metal`,faId:fa.id,kind:'guide-metal',sourceRegionId:r.id,
    volume_m3:fullGuideArea*(z1-z0),referenceMass_kg:fullGuideArea*(z1-z0)*rhoC})
   add({stockId:`${fa.id}/guide-bore-support`,faId:fa.id,kind:'guide-bore-support',sourceRegionId:r.id,volume_m3:boreArea*(z1-z0)})
  }
  for(const [kind,r,mass] of [['bottom-fitting',lower[0]!,h.bottomFitting_kg],['top-fitting',upper[0]!,h.topFitting_kg],
   ['plenum-clad',upper[0]!,f.rodsPerAssembly*Math.PI*(ro**2-ri**2)*f.plenumLength_m*rhoC]] as const)
   add({stockId:`${fa.id}/${kind}`,faId:fa.id,kind,sourceRegionId:r.id,volume_m3:mass/rhoC,referenceMass_kg:mass})
  // The active composite already encloses its gap. Only the separately located
  // plenum bore is additional displacement, tied to the SAME FA helium owner.
  add({stockId:`${fa.id}/helium`,faId:fa.id,kind:'plenum-sealed-space-support',sourceRegionId:upper[0]!.id,
   volume_m3:f.rodsPerAssembly*Math.PI*ri**2*f.plenumLength_m})
  const VHe=f.rodsPerAssembly*Math.PI*((ri**2-rf**2)*f.activeLength_m+ri**2*f.plenumLength_m),nR=f.fillPressure_Pa*VHe/T
  helium.push({faId:fa.id,volume_m3:VHe,nR_J_K:nR,original_K:T,originalInternalEnergy_J:1.5*nR*T})
  const ownMaterial=material.slice(firstMaterial),activeIds=new Set(active.map(r=>r.id))
  close(sum(ownMaterial.filter(q=>activeIds.has(q.sourceRegionId)).map(q=>q.volume_m3)),pitch**2*f.activeLength_m,fa.id+' active envelope')
 }
 const weightByIntersection=new Map<string,number>(),weightByCohort=new Map<string,number>()
 for(const e of heat){const key=e.segmentId+'|'+e.sourceRegionId;weightByIntersection.set(key,(weightByIntersection.get(key)??0)+e.W_kg)
  weightByCohort.set(e.cohortId,(weightByCohort.get(e.cohortId)??0)+e.W_kg)}
 for(const e of heat)e.eta=e.W_kg/weightByIntersection.get(e.segmentId+'|'+e.sourceRegionId)!
 for(const q of cohorts.filter(q=>q.material==='fuel'))close(weightByCohort.get(q.id)??0,q.referenceMass_kg,q.id)
 for(const s of segments){const rows=fissionIncidence.filter(e=>e.segmentId===s.id)
  close(sum(rows.map(e=>e.delayedBirthShare)),1,s.id+' birth');
  close(sum(cohorts.filter(q=>q.segmentId===s.id&&q.material==='fuel').map(q=>q.referenceMass_kg)),s.referenceFuelMass_kg,s.id+' fuel')
  close(sum(cohorts.filter(q=>q.segmentId===s.id&&q.material==='clad').map(q=>q.referenceMass_kg)),s.referenceCladMass_kg,s.id+' clad')
  close(sum(cohorts.filter(q=>q.segmentId===s.id&&q.material==='fuel').map(q=>q.mu!)),1,s.id+' delayed heat')
 }
 const geometry=fuelGeometry(f),fuelMass=sum(cohorts.filter(q=>q.material==='fuel').map(q=>q.referenceMass_kg)),
  cladMass=sum(cohorts.filter(q=>q.material==='clad').map(q=>q.referenceMass_kg))
 close(fuelMass,geometry.fuelMass_kg,'whole cold fuel');close(cladMass,geometry.cladMass_kg,'whole active clad')
 close(sum(material.filter(q=>q.kind==='guide-metal').map(q=>q.volume_m3)),f.assemblies*f.guidesPerAssembly*Math.PI*(go**2-gi**2)*(fullTop-h.seatedBottom_m),'whole guide metal')
 const handling=fuelHandlingChecks(h,f)
 close(sum(material.filter(q=>!['guide-bore-support','external-water-support'].includes(q.kind)).map(q=>q.volume_m3)),
  f.assemblies*handling.assembly.fullDisplacement_m3,'whole once-only FA envelope')
 const apparatus=nuclearObservationGeometry(n,h,input.source),radius=n.carrierOD_m/2,
  lo=n.carrierCentre_m-n.carrierLength_m/2,hi=n.carrierCentre_m+n.carrierLength_m/2,
  converterIncidence:{sourceRegionId:string,area_m2:number}[]=[]
 for(const r of active){const length=overlap(lo,hi,r.z0_m!,r.z1_m!);if(length===0)continue
  if(r.diskRadius_m!==undefined&&radius>=r.diskRadius_m)throw Error('Converter outside source disk')
  const angle=sum(circleRectangleArcs(radius,r.box!).map(a=>a.hi-a.lo)),A=radius*angle*length
  if(A>0)converterIncidence.push({sourceRegionId:r.id,area_m2:A})
 }
 close(sum(converterIncidence.map(q=>q.area_m2)),apparatus.geometry.opticalArea_m2,'whole converter surface')
 if(new Set(cohorts.map(q=>q.id)).size!==cohorts.length)throw Error('Duplicated thermal owner')
 return {preparation:'ORIGINAL fresh seated cold300K',grid,segments,cohorts,materialIncidence:material,heatIncidence:heat,fissionIncidence,helium,
  converter:{radius_m:radius,z0_m:lo,z1_m:hi,opticalArea_m2:apparatus.geometry.opticalArea_m2,
   filmOuterRadius_m:apparatus.geometry.filmOuterRadius_m,b10Mass_kg:apparatus.geometry.b10Mass_kg,incidence:converterIncidence},
  totals:{assemblies:expectedFA.length,historySegments:segments.length,solidCohorts:cohorts.length,heliumOwners:helium.length,
   fuelMass_kg:fuelMass,activeCladMass_kg:cladMass},
  scope:'Cold original FA geometry/reference-mass/thermal W-eta-mu and converter carrier-surface incidence only. Guide-bore/external-water rows are geometric support, NOT occupied native water. Guide/fitting/plenum material rows are reference incidence, NOT extra thermal stocks or new neutron reaction credit. No absorber/moderator/current isotope coefficients, normal field/calibration, source/heat advancement or accuracy admission.'}
}
function cohortFactory(faId:string,segments:{id:string,z0_m:number,z1_m:number,referenceFuelMass_kg:number}[],grid:z.infer<typeof gridSchema>,
 fuel:ReturnType<typeof radialCohorts>,clad:ReturnType<typeof radialCohorts>,rhoF:number,rhoC:number,rods:number,T:number):Cohort[]{
 const lo=segments[0]!.z0_m,hi=segments[1]!.z1_m,result:Cohort[]=[]
 for(let band=0;band<grid.axialBands;band++){
  const z0=lo+(hi-lo)*band/grid.axialBands,z1=lo+(hi-lo)*(band+1)/grid.axialBands,segment=segments[Math.floor(2*band/grid.axialBands)]!
  for(const [material,shells,density] of [['fuel',fuel,rhoF],['clad',clad,rhoC]] as const)for(const shell of shells){
   const mass=rods*Math.PI*(shell.outer_m**2-shell.inner_m**2)*(z1-z0)*density
   result.push({id:`${faId}/thermal/${band}/${material}/${shell.node}`,faId,segmentId:segment.id,band,material,node:shell.node,
    z0_m:z0,z1_m:z1,radius_m:shell.radius_m,inner_m:shell.inner_m,outer_m:shell.outer_m,
    referenceMass_kg:mass,original_K:T,originalSensibleEnergy_J:0,...(material==='fuel'?{mu:mass/segment.referenceFuelMass_kg}:{})})
  }
 }
 return result
}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export const coldSourceMaterialOwnerFiles=['systems/reactor/fuel-construction.md','systems/reactor/fuel-handling-and-pool.md','systems/reactor/control-absorber-and-guide-water.md',
 'systems/primary-coolant/mechanical-energy-and-geometry.md','systems/reactor/core-coolant-delivery.md','model/connected-primary-initialization.md',
 'model/operating-source-model.md','systems/reactor/radial-energy-transient.md','systems/instrumentation/nuclear-observation-apparatus.md','systems/reactor/cold-source-and-startup.md']
export function compileColdSourceMaterialOwners(docs:readonly string[]){
 if(docs.length!==coldSourceMaterialOwnerFiles.length)throw Error('Missing ORIGINAL material owners')
 const base={fuel:parseFuelConstruction(docs[0]!),handling:parseFuelHandling(docs[1]!),control:parseControlAbsorber(docs[2]!),
  primary:parsePrimaryMechanics(docs[3]!),barrel:parsePrimaryBarrelGeometry(docs[4]!),initialization:parseInitializationBasis(docs[5]!),partition:parseSourcePartition(docs[6]!)},
  input={fuel:base.fuel,handling:base.handling,grid:parseOperatingFuelCohorts(docs[7]!),apparatus:parseNuclearObservation(docs[8]!),source:{birthEmission_neutrons_s:parseColdNuclear(docs[9]!).source.birthEmission_neutrons_s}},
  partition=compileSourcePartition(base),result=compileColdSourceMaterial(partition,input)
 return {input,partition,result}
}
if(import.meta.main){
 const [wiki,output]=Bun.argv.slice(2);if(!wiki||!output)throw Error('Usage: bun reference-design-source-material.ts <LD-01 directory> <NEW receipt.json>')
 const files=coldSourceMaterialOwnerFiles,docs=await Promise.all(files.map(name=>Bun.file(join(wiki,name)).text())),
  began=performance.now(),{input,partition,result}=compileColdSourceMaterialOwners(docs),elapsedSeconds=(performance.now()-began)/1000,
  helpers=['reference-design-source-partition.ts','reference-design-source-faces.ts','reference-design-fuel-construction.ts','reference-design-fuel-handling.ts',
   'reference-design-control-absorber.ts','reference-design-primary-mechanics.ts','reference-design-initialization.ts','reference-design-nuclear-observation.ts','reference-design-cold-nuclear.ts'],
  helperIdentities=await Promise.all(helpers.map(async name=>({name,sha256:sha(await Bun.file(new URL(name,import.meta.url)).text())})))
 if((await Promise.all(files.map(name=>Bun.file(join(wiki,name)).text()))).some((doc,i)=>doc!==docs[i]))throw Error('Physical owner changed during compilation')
 await writeFile(output,JSON.stringify({input,result,elapsedSeconds,partitionIdentitySHA256:sha(JSON.stringify(partition)),sourceSHA256:sha(await Bun.file(import.meta.path).text()),helperIdentities,
  consumed:files.map((name,i)=>({name,sha256:sha(docs[i]!)}))},null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({receipt:output,totals:result.totals,converter:result.converter,elapsedSeconds}))
}
