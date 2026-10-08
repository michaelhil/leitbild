/** ORIGINAL passive material/receiving incidence for the seven-group comparator.
 * No state advancement, reaction-library calibration or production selection. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {configurationBlock,parseConfigurationMaterial} from './reference-design-source-laws'
import {parseConfigurationModerator} from './reference-design-source-moderator'
import {compileSourcePartition,diskRectangleArea,type Rectangle,type SourceRegion} from './reference-design-source-partition'
import {controlAbsorberGeometry} from './reference-design-control-absorber'
import {fuelHandlingChecks} from './reference-design-fuel-handling'
import {currentColdGeometry} from './reference-design-current-cold-parent'
import type {compileColdSourceMaterial} from './reference-design-source-material'
import type {parsePrimaryWaterInputs} from './reference-design-source-water'
import type {SourceFace} from './reference-design-source-faces'

const positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative(),seven=z.array(nonnegative).length(7)
const addedSchema=z.object({steel304:z.object({density:positive,elements:z.array(z.string()).length(4),massFractions:z.array(positive).length(4),
 molarMass:z.array(positive).length(4),scatter:z.array(nonnegative).length(4),absorption:z.array(nonnegative).length(4)}).strict(),
 guideZr:z.object({density:positive,molarMass:positive,scatter:nonnegative,absorption:nonnegative}).strict(),
 B4C:z.object({density:positive,molarMass:positive,B10AtomFraction:positive.max(1),boundScatterBarn:z.object({B10:nonnegative,B11:nonnegative,C:nonnegative}).strict()}).strict(),
 scatterMapping:z.literal('within-group elastic in all seven groups'),addedSolidAbsorptionGroups:z.tuple([z.literal(7)])})
export function parsePassiveMaterialLaw(document:string){
 const added=addedSchema.parse(configurationBlock(document,'reference-configuration-added-material')),
  moderator=parseConfigurationModerator(document),material=parseConfigurationMaterial(document)
 if(added.steel304.elements.join('/')!=='Fe/Cr/Ni/Mn'||Math.abs(added.steel304.massFractions.reduce((s,x)=>s+x,0)-1)>8*Number.EPSILON)
  throw Error('Unselected elemental 304 composition')
 const binding=(component:string,n:number)=>{
  const rows=document.split('\n').filter(line=>line.startsWith('| '+component+' |'))
  if(rows.length!==1)throw Error('Missing/duplicated capture-binding authority '+component)
  const values=rows[0]!.split('|')[3]!.split('/').map(x=>Number(x.trim()))
  return z.array(nonnegative).length(n).parse(values).map(x=>x*1.602176634e-13)
 }
 return {...added,boronSigma:moderator.law.boron_sigma,speed:material.speed,
  steelBinding_J:binding('304 Fe/Cr/Ni/Mn contributions',4),zrBinding_J:binding('Guide/other selected Zr',1)[0]!,boronEmission_J:moderator.law.boron_emission}
}
type Inputs=ReturnType<typeof parsePrimaryWaterInputs>
type Material=ReturnType<typeof compileColdSourceMaterial>
type Kind='steel304'|'Zr'|'B4C'
type Target={id:string,referenceAtoms:number,atoms:number,productAtoms:number,sigma_m2:number[],bindingEmission_J:[number,number]}
export type PassiveStock={id:string,material:Kind,volume_m3:number,mass_kg:number,thermalRecipientId:string,
 referenceScatter_m1:number[],targets:Target[],captureMode:'volume'|'optical'|'cylinder',original_K:number}
type Primitive={stockId:string,lo:number,hi:number,shape:{kind:'annulus',x:number,y:number,inner:number,outer:number}|{kind:'box',box:Rectangle},scale:number}
type Incidence={stockId:string,sourceRegionId:string,volume_m3:number}
const overlap=(a:number,b:number,c:number,d:number)=>Math.max(0,Math.min(b,d)-Math.max(a,c))
const sum=(xs:readonly number[])=>xs.reduce((a,b)=>a+b,0)
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
function near(a:number,b:number,label:string,scale=Math.abs(b)){
 if(!Number.isFinite(a+b)||Math.abs(a-b)>4e-10*Math.max(scale,1e-15))throw Error('Passive coverage does not close: '+label+' '+a+' vs '+b)
}
function circle(box:Rectangle,x:number,y:number,r:number){
 if(r===0)return 0
 if(box.x1<=x-r||box.x0>=x+r||box.y1<=y-r||box.y0>=y+r)return 0
 if(box.x0<=x-r&&box.x1>=x+r&&box.y0<=y-r&&box.y1>=y+r)return Math.PI*r*r
 return diskRectangleArea(r,{x0:box.x0-x,x1:box.x1-x,y0:box.y0-y,y1:box.y1-y})
}
function area(p:Primitive,box:Rectangle){
 const s=p.shape
 const a=s.kind==='box'?overlap(box.x0,box.x1,s.box.x0,s.box.x1)*overlap(box.y0,box.y1,s.box.y0,s.box.y1):
  circle(box,s.x,s.y,s.outer)-circle(box,s.x,s.y,s.inner)
 if(a<0||!Number.isFinite(a))throw Error('Invalid positive primitive intersection')
 return a*p.scale
}

/** One physical BODY material decomposition, shared by original preparation
 * and the moving-incidence compiler. No stem/spider material is hidden here. */
export function controlBodyPrimitives(d:Pick<Inputs,'control'|'fuel'|'handling'>){
 const c=d.control,g=controlAbsorberGeometry(c,d.fuel,d.handling),rows:Primitive[]=[]
 for(const site of g.sites){const prefix=`CONTROL/${site.x}/${site.y}`
  for(const pin of g.bodySites){const x=site.x_m+pin.x_m,y=site.y_m+pin.y_m,
   lo=c.insertedBodyBottom_m,hi=lo+c.bodyLength_m,activeLo=c.insertedActiveBottom_m,activeHi=activeLo+c.activeLength_m
   const add=(stockId:string,inner:number,outer:number,lo:number,hi:number)=>{
    if(!(outer>inner&&inner>=0&&hi>lo))throw Error('Invalid BODY material primitive')
    rows.push({stockId,lo,hi,shape:{kind:'annulus',x,y,inner,outer},scale:1})
   }
   add(prefix+'/B4C',0,c.absorberDiameter_m/2,activeLo,activeHi)
   add(prefix+'/STEEL',c.absorberDiameter_m/2,c.bodyDiameter_m/2,activeLo,activeHi)
   if(activeLo>lo)add(prefix+'/STEEL',0,c.bodyDiameter_m/2,lo,activeLo)
   if(hi>activeHi)add(prefix+'/STEEL',0,c.bodyDiameter_m/2,activeHi,hi)
  }
 }
 return {geometry:g,rows}
}

/** Exact ORIGINAL geometry. A changed achieved pose is not parsed as ORIGINAL.
 * Closed head is bulk 304 plus real water holes, never a thin optical heater. */
export function compileOriginalPassiveGeometry(partition:ReturnType<typeof compileSourcePartition>,d:Inputs,material:Material,faces:SourceFace[],sourceOwnerText:string){
 const expected=compileSourcePartition(d)
 if(sha(JSON.stringify(partition))!==sha(JSON.stringify(expected)))throw Error('Passive/source partition lineage mismatch')
 const {control:c,handling:h,fuel:f,attachment:a,head,barrel:b}=d,
  law=parsePassiveMaterialLaw(sourceOwnerText),NA=d.chemistry.avogadro_mol,
  {geometry:cg,rows:bodyPrimitives}=controlBodyPrimitives(d),current=currentColdGeometry(c,a,f,h,d.gates,head,d.cold),fg=fuelHandlingChecks(h,f),
  activeBottom=h.seatedBottom_m+h.bottomFittingLength_m,activeTop=activeBottom+f.activeLength_m,
  stockMap=new Map<string,PassiveStock>(),primitives:Primitive[]=[],incidence:Incidence[]=[],regions=new Map(partition.regions.map(r=>[r.id,r]))
 if(law.steel304.density!==c.steelDensity_kg_m3||law.guideZr.density!==f.cladDensity_kg_m3
  ||law.B4C.density!==h.b4cDensity_kg_m3||law.B4C.B10AtomFraction!==h.b10AtomFraction||law.B4C.molarMass!==h.b4cMolarMass_kg_mol)
  throw Error('Physical/material density or isotope authority mismatch')
 const stock=(id:string,kind:Kind,V:number,T:number,captureMode:PassiveStock['captureMode']='volume',host=id)=>{
  if(stockMap.has(id)||!(V>0&&Number.isFinite(V))||!(T>0&&Number.isFinite(T)))throw Error('Invalid/duplicate passive stock')
  const rho=kind==='steel304'?law.steel304.density:kind==='Zr'?law.guideZr.density:law.B4C.density,M=V*rho,
   targets:Target[]=[],scattering=kind==='steel304'?sum(law.steel304.elements.map((_,i)=>rho*law.steel304.massFractions[i]!*NA/law.steel304.molarMass[i]!*law.steel304.scatter[i]!*1e-28)):
    kind==='Zr'?rho*NA/law.guideZr.molarMass*law.guideZr.scatter*1e-28:
    rho*NA/law.B4C.molarMass*(4*law.B4C.B10AtomFraction*law.B4C.boundScatterBarn.B10+4*(1-law.B4C.B10AtomFraction)*law.B4C.boundScatterBarn.B11+law.B4C.boundScatterBarn.C)*1e-28
  const add=(suffix:string,N:number,sigma:number[],emission:[number,number])=>targets.push({id:id+'/'+suffix,referenceAtoms:N,atoms:N,productAtoms:0,sigma_m2:seven.parse(sigma),bindingEmission_J:emission})
  if(kind==='steel304')law.steel304.elements.forEach((element,i)=>add(element,M*law.steel304.massFractions[i]!*NA/law.steel304.molarMass[i]!,Array.from({length:7},(_,g)=>g===6?law.steel304.absorption[i]!*1e-28:0),[0,law.steelBinding_J[i]!]))
  else if(kind==='Zr')add('Zr',M*NA/law.guideZr.molarMass,Array.from({length:7},(_,g)=>g===6?law.guideZr.absorption*1e-28:0),[0,law.zrBinding_J])
  else add('B10',4*M*NA/law.B4C.molarMass*law.B4C.B10AtomFraction,law.boronSigma,[law.boronEmission_J[0]!,law.boronEmission_J[1]!])
  const row:PassiveStock={id,material:kind,volume_m3:V,mass_kg:M,thermalRecipientId:host,referenceScatter_m1:Array(7).fill(scattering),targets,captureMode,original_K:T}
  if(!Number.isFinite(M+scattering)||targets.some(t=>!Number.isFinite(t.atoms)))throw Error('Nonfinite passive original stock')
  stockMap.set(id,row);return row
 }
 const annulus=(id:string,x:number,y:number,inner:number,outer:number,lo:number,hi:number)=>{
  if(!(outer>inner&&inner>=0&&hi>lo))throw Error('Invalid annular material primitive')
  primitives.push({stockId:id,lo,hi,shape:{kind:'annulus',x,y,inner,outer},scale:1})
 }
 const box=(id:string,r:Rectangle,lo:number,hi:number)=>{
  if(!(r.x1>r.x0&&r.y1>r.y0&&hi>lo))throw Error('Invalid rectangular material primitive')
  primitives.push({stockId:id,lo,hi,shape:{kind:'box',box:r},scale:1})
 }
 // One full six-metre stock; neutron incidence deliberately represents four.
 stock('BARREL','steel304',Math.PI*(b.outerRadius_m**2-b.innerRadius_m**2)*(d.primary.downcomerTop_m-d.primary.downcomerBottom_m),300)
 annulus('BARREL',0,0,b.innerRadius_m,b.outerRadius_m,d.primary.downcomerBottom_m,d.primary.downcomerTop_m)
 // Reuse actual existing guide/fitting/plenum incidence, not composite cladding.
 const zrRows=material.materialIncidence.filter(r=>['guide-metal','bottom-fitting','top-fitting','plenum-clad'].includes(r.kind)),zrGroups=new Map<string,typeof zrRows>()
 const guideLength=h.bottomFittingLength_m+f.activeLength_m+f.plenumLength_m+h.topFittingLength_m,
  rodOuter=f.rodOuterDiameter_m/2,rodInner=rodOuter-f.cladThickness_m,
  zrVolumes={'guide-metal':f.guidesPerAssembly*Math.PI*((f.guideOuterDiameter_m/2)**2-(h.guideInnerDiameter_m/2)**2)*guideLength,
   'bottom-fitting':h.bottomFitting_kg/law.guideZr.density,'top-fitting':h.topFitting_kg/law.guideZr.density,
   'plenum-clad':f.rodsPerAssembly*Math.PI*(rodOuter**2-rodInner**2)*f.plenumLength_m},
  expectedZr=new Map(partition.assemblies.flatMap(fa=>Object.entries(zrVolumes).map(([kind,V])=>[fa.id+'/'+kind,V] as const)))
 for(const r of zrRows){if(!expectedZr.has(r.stockId)||r.stockId!==r.faId+'/'+r.kind||!(r.volume_m3>0&&Number.isFinite(r.volume_m3))
   ||r.referenceMass_kg===undefined)throw Error('Invalid/missing original Zr material authority')
  near(r.referenceMass_kg,r.volume_m3*law.guideZr.density,'Zr reference mass '+r.stockId)
  const rows=zrGroups.get(r.stockId)??[];rows.push(r);zrGroups.set(r.stockId,rows)}
 if(zrGroups.size!==expectedZr.size)throw Error('Missing original Zr material stock')
 for(const [id,V] of expectedZr)near(sum((zrGroups.get(id)??[]).map(r=>r.volume_m3)),V,'original Zr stock '+id)
 for(const [id,rows] of zrGroups){const V=sum(rows.map(r=>r.volume_m3));stock(id,'Zr',V,300);for(const r of rows){if(!regions.has(r.sourceRegionId))throw Error('Unmapped guide/fitting material');incidence.push({stockId:id,sourceRegionId:r.sourceRegionId,volume_m3:r.volume_m3})}}
 const slabV=(c.headGrossArea_m2-c.clusters*Math.PI*(c.housingID_m/2)**2)*c.headThickness_m,
  slab=stock('HEAD.SLAB','steel304',slabV,d.cold.primaryMetalTemperature_K,'volume','HEAD.ATTACHED'),R=Math.sqrt(c.headGrossArea_m2/Math.PI),
  headLo=c.headBottom_m,headHi=headLo+c.headThickness_m
 // Signed geometrical hole subtraction is confined to this disjoint slab;
 // these are not negative material stocks or signed reaction intersections.
 primitives.push({stockId:slab.id,lo:headLo,hi:headHi,shape:{kind:'annulus',x:0,y:0,inner:0,outer:R},scale:1})
 for(const site of cg.sites)primitives.push({stockId:slab.id,lo:headLo,hi:headHi,shape:{kind:'annulus',x:site.x_m,y:site.y_m,inner:0,outer:c.housingID_m/2},scale:-1})
 const capTop=c.housingTop_m+c.housingCapHeight_m,
  housingV=c.clusters*Math.PI*((c.housingOD_m/2)**2-(c.housingID_m/2)**2)*(c.housingTop_m-headHi),
  capV=c.clusters*Math.PI*((c.housingOD_m/2)**2-(c.neckID_m/2)**2)*c.housingCapHeight_m,
  neckV=c.clusters*Math.PI*((c.neckOD_m/2)**2-(c.neckID_m/2)**2)*(c.neckTop_m-capTop),
  neckCapV=c.clusters*Math.PI*(c.neckOD_m/2)**2*c.neckCapHeight_m,
  collarV=c.clusters*c.collarBottoms_m.length*Math.PI*((c.collarOD_m/2)**2-(c.collarID_m/2)**2)*c.collarHeight_m,
  jackV=c.clusters*c.attachedJackMassPerCluster_kg/c.steelDensity_kg_m3
 for(const [id,V] of [['HEAD.HOUSING',housingV],['HEAD.CAP',capV],['HEAD.NECK',neckV],['HEAD.NECKCAP',neckCapV],['HEAD.COLLARS',collarV],['HEAD.JACKS',jackV]] as const)stock(id,'steel304',V,d.cold.primaryMetalTemperature_K,'volume','HEAD.ATTACHED')
 for(const s of cg.sites){
  annulus('HEAD.HOUSING',s.x_m,s.y_m,c.housingID_m/2,c.housingOD_m/2,headHi,c.housingTop_m)
  annulus('HEAD.CAP',s.x_m,s.y_m,c.neckID_m/2,c.housingOD_m/2,c.housingTop_m,capTop)
  annulus('HEAD.NECK',s.x_m,s.y_m,c.neckID_m/2,c.neckOD_m/2,capTop,c.neckTop_m)
  annulus('HEAD.NECKCAP',s.x_m,s.y_m,0,c.neckOD_m/2,c.neckTop_m,c.neckTop_m+c.neckCapHeight_m)
  for(const z of c.collarBottoms_m)annulus('HEAD.COLLARS',s.x_m,s.y_m,c.collarID_m/2,c.collarOD_m/2,z,z+c.collarHeight_m)
  annulus('HEAD.JACKS',s.x_m,s.y_m,c.jackID_m/2,c.jackOD_m/2,cg.head.jackBottom_m,cg.head.jackTop_m)
 }
 near((slabV+housingV+capV+neckV+neckCapV+collarV+jackV)*c.steelDensity_kg_m3,cg.head.attachedTotal_kg,'one attached head assembly')
 // Actual body shell/end steel and B4C use distinct volumes. B10 response is
 // NOT planar E3; only its fixed scattering is consumed by this payload.
 for(const s of cg.sites){const prefix=`CONTROL/${s.x}/${s.y}`,count=c.rodletsPerCluster,
  vb=count*Math.PI*(c.absorberDiameter_m/2)**2*c.activeLength_m,
  vs=cg.moving.bodySteel_kg/c.clusters/c.steelDensity_kg_m3
  stock(prefix+'/B4C','B4C',vb,d.cold.primaryMetalTemperature_K,'cylinder',prefix+'/BODY')
  stock(prefix+'/STEEL','steel304',vs,d.cold.primaryMetalTemperature_K,'volume',prefix+'/BODY')
 }
 primitives.push(...bodyPrimitives)
 const rackBottom=partition.panelSupport_m.bottom,rackTop=partition.panelSupport_m.top,
  outer=h.rackSleeveSide_m/2,skin=h.rackSkin_m,thickness=fg.rack.matrixThickness_m,inner=outer-2*skin-thickness,
  mid=outer-skin-thickness/2,rackMatrices=new Map<string,PassiveStock>(),rackSkins=new Map<string,PassiveStock>()
 for(const rack of partition.racks){
  const matrix=stock(rack.id+'/MATRIX','B4C',fg.rack.oneSleeveMatrix_kg/law.B4C.density,head.cnvTemperature_K,'optical'),
   skins=stock(rack.id+'/SKINS','steel304',fg.rack.oneSleeveSkin_kg/law.steel304.density,head.cnvTemperature_K,'optical')
  rackMatrices.set(rack.id,matrix);rackSkins.set(rack.id,skins)
  const square=(half:number):Rectangle=>({x0:rack.x_m-half,x1:rack.x_m+half,y0:rack.y_m-half,y1:rack.y_m+half})
  // Square-ring decomposition uses signed geometry locally; resulting physical
  // material incidences are nonnegative and counted once, corners included.
  for(const [id,lo,hi] of [[skins.id,outer-skin,outer],[matrix.id,inner+skin,outer-skin],[skins.id,inner,inner+skin]] as const){
   box(id,square(hi),rackBottom,rackTop);primitives.push({stockId:id,lo:rackBottom,hi:rackTop,shape:{kind:'box',box:square(lo)},scale:-1})
  }
 }
 const wellRight=Math.max(...partition.regions.filter(r=>r.compartment==='WELL').map(r=>r.box!.x1)),poolLeft=Math.min(...partition.regions.filter(r=>r.compartment==='POOL').map(r=>r.box!.x0)),gateStocks=new Map<string,PassiveStock>()
 for(const [id,x0,x1,n] of [['GATE.WELL',wellRight-d.gates.thickness_m,wellRight,0],['GATE.POOL',poolLeft,poolLeft+d.gates.thickness_m,1]] as const){
  const lo=d.gates.sills_m[n],hi=d.gates.top_m,V=d.gates.width_m*d.gates.thickness_m*(hi-lo),row=stock(id,'steel304',V,head.cnvTemperature_K,'optical')
  gateStocks.set(id,row);box(id,{x0,x1,y0:-d.gates.width_m/2,y1:d.gates.width_m/2},lo,hi)
 }
 // Compile each primitive once. Equipment-node embeddings remain explicit,
 // rather than inventing rectangular LOWER/UPPER solids from gross water V.
 for(const r of partition.regions){
  const local=new Map<string,number>()
  if(r.box){for(const p of primitives){const dz=overlap(p.lo,p.hi,r.z0_m!,r.z1_m!);if(dz===0)continue;const V=area(p,r.box)*dz;if(V!==0)local.set(p.stockId,(local.get(p.stockId)??0)+V)}}
  else if(r.id==='LOWER'||r.id==='UPPER'){
   const lo=r.id==='LOWER'?d.primary.downcomerBottom_m:activeTop,hi=r.id==='LOWER'?activeBottom:c.headBottom_m
   for(const p of primitives){if(!p.stockId.startsWith('CONTROL/'))continue;const dz=overlap(p.lo,p.hi,lo,hi);if(dz===0)continue
    const shape=p.shape,V=(shape.kind==='annulus'?Math.PI*(shape.outer**2-shape.inner**2):(shape.box.x1-shape.box.x0)*(shape.box.y1-shape.box.y0))*p.scale*dz
    local.set(p.stockId,(local.get(p.stockId)??0)+V)
   }
  }
  for(const [stockId,V] of local){if(V<0||!Number.isFinite(V))throw Error('Negative physical material incidence '+stockId+' '+r.id);if(V>0)incidence.push({stockId,sourceRegionId:r.id,volume_m3:V})}
 }
 // Receiving water excludes the entire enclosed primary passage envelope,
 // not just the wall, then excludes external jacks/rack/gate material once.
 const receivingPieces:{owner:string,sourceRegionId:string,volume_m3:number,momentZ_m4:number}[]=[],bayClosure:{owner:string,grossVolume_m3:number,excludedVolume_m3:number,freeVolume_m3:number,momentZ_m4:number}[]=[]
 for(const compartment of ['WELL','CANAL','POOL'] as const){let gross=0,free=0,moment=0
  for(const r of partition.regions.filter(r=>r.compartment===compartment)){
   const cuts=[...new Set([r.z0_m!,r.z1_m!,...primitives.flatMap(p=>[p.lo,p.hi]).filter(z=>z>r.z0_m!&&z<r.z1_m!),...current.envelope.flatMap(p=>[p.lo,p.hi]).filter(z=>z>r.z0_m!&&z<r.z1_m!)])].sort((a,b)=>a-b)
   let V=0,J=0;const grossArea=(r.box!.x1-r.box!.x0)*(r.box!.y1-r.box!.y0)
   for(let k=1;k<cuts.length;k++){const lo=cuts[k-1]!,hi=cuts[k]!,z=(lo+hi)/2;let excluded=0
    if(compartment==='WELL'){
     if(z>headLo&&z<headHi)excluded+=circle(r.box!,0,0,R)
     for(const s of cg.sites){
      if(z>headHi&&z<capTop)excluded+=circle(r.box!,s.x_m,s.y_m,c.housingOD_m/2)
      else if(z>capTop&&z<c.neckTop_m+c.neckCapHeight_m)excluded+=circle(r.box!,s.x_m,s.y_m,c.neckOD_m/2)
      if(z>cg.head.jackBottom_m&&z<cg.head.jackTop_m)excluded+=circle(r.box!,s.x_m,s.y_m,c.jackOD_m/2)-circle(r.box!,s.x_m,s.y_m,c.jackID_m/2)
     }
    }
    for(const p of primitives)if((p.stockId.startsWith('RACK/')||p.stockId.startsWith('GATE.'))&&z>p.lo&&z<p.hi)excluded+=area(p,r.box!)
    const A=grossArea-excluded;if(A<0||!Number.isFinite(A))throw Error('Receiving free area lost positivity '+r.id)
    V+=A*(hi-lo);J+=A*(hi*hi-lo*lo)/2
   }
   gross+=r.volume_m3;free+=V;moment+=J;if(V>0)receivingPieces.push({owner:compartment,sourceRegionId:r.id,volume_m3:V,momentZ_m4:J})
  }
  bayClosure.push({owner:compartment,grossVolume_m3:gross,excludedVolume_m3:gross-free,freeVolume_m3:free,momentZ_m4:moment})
 }
 const expectedWellExcluded=current.envelope.reduce((s,p)=>s+p.area*overlap(p.lo,p.hi,h.wellFloor_m,h.surface_m),0)+gateStocks.get('GATE.WELL')!.volume_m3,
  expectedPoolExcluded=current.rackDisplacement_m3+gateStocks.get('GATE.POOL')!.volume_m3
 near(bayClosure[0]!.excludedVolume_m3,expectedWellExcluded,'WELL outer/primary-envelope + gate',bayClosure[0]!.grossVolume_m3)
 near(bayClosure[1]!.excludedVolume_m3,0,'CANAL no original occupied hardware',bayClosure[1]!.grossVolume_m3)
 near(bayClosure[2]!.excludedVolume_m3,expectedPoolExcluded,'POOL sleeves + gate',bayClosure[2]!.grossVolume_m3)
 const stocks=[...stockMap.values()],stockCoverage=stocks.map(s=>{
  const represented=sum(incidence.filter(r=>r.stockId===s.id).map(r=>r.volume_m3)),outside=s.volume_m3-represented
  if(outside< -4e-10*s.volume_m3)throw Error('Duplicated stock neutron incidence '+s.id)
  if(s.id!=='BARREL')near(represented,s.volume_m3,s.id)
  else near(represented,Math.PI*(b.outerRadius_m**2-b.innerRadius_m**2)*f.activeLength_m,'represented barrel')
  return {stockId:s.id,totalVolume_m3:s.volume_m3,representedVolume_m3:represented,uncreditedOutsideVolume_m3:outside}
 })
 const opticalFaces:{faceIndex:number,supportId:string,layers:{columns:{targetId:string,atoms_per_m2:number,sigma_m2:number[]}[]}[]}[]=[],headBulkAdmission:{faceIndex:number,receiverRegionId:string,holeArea_m2:number,steelArea_m2:number}[]=[],covered=new Map<string,number>()
 const columns=(s:PassiveStock,L:number)=>s.targets.map(t=>({targetId:t.id,atoms_per_m2:t.atoms/s.volume_m3*L,sigma_m2:t.sigma_m2}))
 faces.forEach((face,faceIndex)=>{if(!face.support)return
  const supportId=face.support.id
  if(face.support.kind==='head-mouth'){
   const receiver=regions.get(face.left==='UPPER'?face.right!:face.left);if(!receiver?.box||receiver.compartment!=='WELL')throw Error('Invalid bulk head mouth')
   const holes=sum(cg.sites.map(s=>circle(receiver.box!,s.x_m,s.y_m,c.housingID_m/2))),steel=face.area_m2-holes
   if(steel<0)throw Error('Head hole/steel patch does not partition');headBulkAdmission.push({faceIndex,receiverRegionId:receiver.id,holeArea_m2:holes,steelArea_m2:steel})
  }else if(face.support.kind==='transfer-gate'){
   const s=gateStocks.get(supportId);if(!s)throw Error('Unknown actual gate material');opticalFaces.push({faceIndex,supportId,layers:[{columns:columns(s,d.gates.thickness_m)}]});covered.set(supportId,(covered.get(supportId)??0)+face.area_m2)
  }else {
   const rackId=supportId.split('/').slice(0,3).join('/'),matrix=rackMatrices.get(rackId),skins=rackSkins.get(rackId)
   if(!matrix||!skins)throw Error('Unknown immutable rack panel');opticalFaces.push({faceIndex,supportId,layers:[{columns:columns(skins,skin)},{columns:columns(matrix,thickness)},{columns:columns(skins,skin)}]});covered.set(rackId,(covered.get(rackId)??0)+face.area_m2)
  }
 })
 for(const [id,s] of gateStocks)near(covered.get(id)??0,s.volume_m3/d.gates.thickness_m,'ORIGINAL closed gate '+id)
 for(const rack of partition.racks)near(covered.get(rack.id)??0,8*mid*(rackTop-rackBottom),'rack physical midplane '+rack.id)
 near(sum(headBulkAdmission.map(r=>r.holeArea_m2)),c.clusters*Math.PI*(c.housingID_m/2)**2,'head primary holes')
 near(sum(headBulkAdmission.map(r=>r.holeArea_m2+r.steelArea_m2)),c.headGrossArea_m2,'head entire mouth')
 const volumeMaterial=incidence.map(e=>({...e,stock:stocks.findIndex(s=>s.id===e.stockId),region:partition.regions.findIndex(r=>r.id===e.sourceRegionId)}))
 return {preparation:'ORIGINAL inserted/seated/closed cold passive geometry',regionVolumes:partition.regions.map(r=>r.volume_m3),speed:law.speed,stocks,volumeMaterial,receivingPieces,bayClosure,stockCoverage,opticalFaces,headBulkAdmission,
  nativeBulk:{stocks:stocks.map(s=>({id:s.id,volume:s.volume_m3,scatter:s.id.startsWith('GATE.')?Array(7).fill(0):s.referenceScatter_m1,
   targets:s.captureMode==='volume'?s.targets.map(t=>({id:t.id,reference_atoms:t.referenceAtoms,sigma:t.sigma_m2,binding_emission:t.bindingEmission_J})):[]})),incidence:volumeMaterial.map(e=>({stock:e.stock,region:e.region,volume:e.volume_m3})),targets:stocks.filter(s=>s.captureMode==='volume').flatMap(s=>s.targets.map(t=>({id:t.id,atoms:t.atoms,products:t.productAtoms})))},
  captureRecipientLinks:stocks.flatMap(s=>s.targets.map(t=>({targetId:t.id,thermalRecipientId:s.thermalRecipientId,chargedLocal:s.material==='B4C',photonProjection:'selected serial physical path NOT yet consumed',bindingEmission_J:t.bindingEmission_J}))),
  missingPhysicalConsumers:['B4C body lateral-cylinder capture and converter film/collection response','retained deposit and isotope/history advancement','paid binding/Mn56 photon/contact deposition and finite thermal recipient advancement','frame/stem/attachment/apparatus reaction projection outside this selected passive payload','external births, Xe/Sm and complete source/fuel/thermal integration'],
  reactionOmissions:['packing/baffle and outer vessel/civil reflection','barrel neutron end response outside active four metres','gate optical-slab scattering/return'],
  completeReactorOperator:false,productionSourceSelected:false,emissionIsDepositedHeat:false,
  scope:'Actual original passive material + receiving free-volume/moment payload for the seven-group comparator. Head bulk/hole admission, ordinary finite target captures, rack/gate layers and fixed within-group scattering; no invented all-export photon map or planar body/converter capture. Stocks/recipients are geometry/preparation identities, not integrated states.'}
}
