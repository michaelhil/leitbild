/** Geometric source face/support compilation only. No current material,
 * attenuation, coefficients, thermal recipients or advancing neutron state. */
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {z} from 'zod'
import {diskRectangleArea,diskRectangleMeasure,sourceRectangleSchema,sourceRegionSchema,type Rectangle,type SourceRegion} from './reference-design-source-partition'
import {parseTransferGates,type TransferGates} from './reference-design-fuel-transfer'

type Partition=ReturnType<typeof import('./reference-design-source-partition').compileSourcePartition>
type FacePartition=Pick<Partition,'regions'|'corePlenumInterfaceArea_m2'|'headArea_m2'|'panelSupport_m'>
const finite=z.number().finite(),positive=finite.positive()
const facePartitionSchema=z.object({regions:z.array(sourceRegionSchema),
 corePlenumInterfaceArea_m2:positive,headArea_m2:positive,panelSupport_m:z.object({bottom:finite,top:finite}).strict()})
type Axis='x'|'y'|'z'
type Facet={id:string,region:SourceRegion,axis:Axis,side:-1|1,plane:number,rect:Rectangle,radius?:number,area:number,distance:number}
export type SourceFace={left:string,right?:string,area_m2:number,leftDistance_m:number,rightDistance_m?:number,
 axis:Axis|'arc'|'equipment',plane_m?:number,meanOutwardNormal:readonly[number,number,number],support?:{id:string,kind:'rack-panel'|'transfer-gate'}}

/** Exact circle-boundary support intervals, split at every rectangle crossing. */
export function circleRectangleArcs(radius:number,box:Rectangle){
 if(!Number.isFinite(radius)||radius<=0||!sourceRectangleSchema.safeParse(box).success)throw Error('Invalid arc geometry')
 const cuts=[0,2*Math.PI]
 const add=(angle:number)=>cuts.push((angle+2*Math.PI)%(2*Math.PI))
 for(const x of [box.x0,box.x1])if(Math.abs(x)<radius){const a=Math.acos(x/radius);add(a);add(-a)}
 for(const y of [box.y0,box.y1])if(Math.abs(y)<radius){const a=Math.asin(y/radius);add(a);add(Math.PI-a)}
 cuts.sort((a,b)=>a-b)
 const arcs:{lo:number,hi:number}[]=[]
 for(let i=1;i<cuts.length;i++){
  const lo=cuts[i-1]!,hi=cuts[i]!,a=(lo+hi)/2,x=radius*Math.cos(a),y=radius*Math.sin(a)
  if(hi>lo&&x>=box.x0&&x<=box.x1&&y>=box.y0&&y<=box.y1)arcs.push({lo,hi})
 }
 return arcs
}
const area=(r:Rectangle,radius?:number)=>radius===undefined?(r.x1-r.x0)*(r.y1-r.y0):diskRectangleArea(radius,r)
const overlap=(a:Rectangle,b:Rectangle):Rectangle|undefined=>{
 const r={x0:Math.max(a.x0,b.x0),x1:Math.min(a.x1,b.x1),y0:Math.max(a.y0,b.y0),y1:Math.min(a.y1,b.y1)}
 return r.x1>r.x0&&r.y1>r.y0?r:undefined
}
export function compileSourceFaces(p:FacePartition,g:Pick<TransferGates,'width_m'|'stroke_m'|'sills_m'|'top_m'>,travel_m:readonly[number,number]){
 if(travel_m.length!==2||g.sills_m.length!==2
  ||![g.width_m,g.stroke_m,g.top_m,...g.sills_m,p.panelSupport_m.bottom,p.panelSupport_m.top].every(Number.isFinite)
  ||!travel_m.every(x=>Number.isFinite(x)&&x>=0&&x<=g.stroke_m)||!(g.width_m>0&&g.stroke_m>0&&g.top_m>Math.max(...g.sills_m)))
  throw Error('Invalid explicitly selected gate geometry/pose')
 const facets:Facet[]=[],faces:SourceFace[]=[],used=new Map<string,number>(),surface=new Map<string,number>()
 if(new Set(p.regions.map(r=>r.id)).size!==p.regions.length||p.panelSupport_m.top<=p.panelSupport_m.bottom)throw Error('Invalid source identities/panel support')
 const addFace=(f:SourceFace)=>{
  if(!(Number.isFinite(f.area_m2)&&f.area_m2>0&&Number.isFinite(f.leftDistance_m)&&f.leftDistance_m>0)
   ||(f.right!==undefined&&!(Number.isFinite(f.rightDistance_m)&&f.rightDistance_m!>0)))throw Error('Nonpositive face geometry/distance')
  faces.push(f)
 }
 const facet=(r:SourceRegion,axis:Axis,side:-1|1,plane:number,rect:Rectangle,distance:number,radius?:number)=>{
  const A=area(rect,radius);if(A===0)return
  facets.push({id:`${r.id}/${axis}/${side}`,region:r,axis,side,plane,rect,distance,...(radius===undefined?{}:{radius}),area:A})
  surface.set(r.id,(surface.get(r.id)??0)+A)
 }
 for(const r of p.regions){
  if(!r.box)continue
  const box=r.box,z0=r.z0_m!,z1=r.z1_m!,measure=r.diskRadius_m===undefined?undefined:diskRectangleMeasure(r.diskRadius_m,box),
   cx=measure?measure.momentX_m3/measure.area_m2:(box.x0+box.x1)/2,
   cy=measure?measure.momentY_m3/measure.area_m2:(box.y0+box.y1)/2,cz=(z0+z1)/2
  if(!(z1>z0&&cx>box.x0&&cx<box.x1&&cy>box.y0&&cy<box.y1))throw Error('Centroid/axial support outside source region')
  for(const [axis,low,high,clow,chigh] of [['x',box.x0,box.x1,box.y0,box.y1],['y',box.y0,box.y1,box.x0,box.x1]] as const){
   for(const [side,plane] of [[-1,low],[1,high]] as const){
    let a0=clow,a1=chigh
    if(r.diskRadius_m!==undefined){if(Math.abs(plane)>=r.diskRadius_m)continue
     const span=Math.sqrt(r.diskRadius_m**2-plane**2);a0=Math.max(a0,-span);a1=Math.min(a1,span)}
    if(a1>a0)facet(r,axis,side,plane,{x0:a0,x1:a1,y0:z0,y1:z1},Math.abs((axis==='x'?cx:cy)-plane))
   }
  }
  facet(r,'z',-1,z0,box,cz-z0,r.diskRadius_m);facet(r,'z',1,z1,box,z1-cz,r.diskRadius_m)
  if(r.diskRadius_m!==undefined)for(const arc of circleRectangleArcs(r.diskRadius_m,box)){
   const angle=arc.hi-arc.lo,A=r.diskRadius_m*angle*(z1-z0),
    nx=(Math.sin(arc.hi)-Math.sin(arc.lo))/angle,ny=(Math.cos(arc.lo)-Math.cos(arc.hi))/angle
   addFace({left:r.id,area_m2:A,leftDistance_m:r.diskRadius_m-cx*nx-cy*ny,axis:'arc',meanOutwardNormal:[nx,ny,0]})
   surface.set(r.id,(surface.get(r.id)??0)+A)
  }
 }
 const active=p.regions.filter(r=>r.compartment==='ACTIVE'),bottom=Math.min(...active.map(r=>r.z0_m!)),top=Math.max(...active.map(r=>r.z1_m!)),
  well=p.regions.filter(r=>r.compartment==='WELL'),pool=p.regions.filter(r=>r.compartment==='POOL'),
  wellRight=Math.max(...well.map(r=>r.box!.x1)),poolLeft=Math.min(...pool.map(r=>r.box!.x0)),
  coreRadius=Math.sqrt(p.corePlenumInterfaceArea_m2/Math.PI),headRadius=Math.sqrt(p.headArea_m2/Math.PI)
 if(!active.length||!well.length||!pool.length||!p.regions.some(r=>r.compartment==='CANAL'))throw Error('Missing source compartment')
 for(const [name,side,plane,R] of [['LOWER',1,bottom,coreRadius],['UPPER',-1,top,coreRadius],['UPPER',1,Math.min(...well.map(r=>r.z0_m!)),headRadius]] as const){
  const r=p.regions.find(r=>r.id===name)!;const A=Math.PI*R*R
  facet(r,'z',side,plane,{x0:-R,x1:R,y0:-R,y1:R},r.volume_m3/(2*A),R)
 }
 const lower=p.regions.find(r=>r.id==='LOWER')!
 addFace({left:lower.id,area_m2:p.corePlenumInterfaceArea_m2,leftDistance_m:lower.volume_m3/(2*p.corePlenumInterfaceArea_m2),axis:'equipment',meanOutwardNormal:[0,0,-1]})
 surface.set(lower.id,(surface.get(lower.id)??0)+p.corePlenumInterfaceArea_m2)
 const groups=new Map<string,{plus:Facet[],minus:Facet[]}>()
 for(const f of facets){const key=`${f.axis}/${f.plane}`,group=groups.get(key)??{plus:[],minus:[]};(f.side===1?group.plus:group.minus).push(f);groups.set(key,group)}
 const consume=(f:Facet,A:number)=>used.set(f.id,(used.get(f.id)??0)+A)
 let gateArea=0,gateCoveredArea=0,panelArea=0
 for(const group of groups.values()){
  const right=group.minus.sort((a,b)=>a.rect.x0-b.rect.x0)
  for(const l of group.plus)for(const r of right){
   if(r.rect.x0>=l.rect.x1)break;if(r.rect.x1<=l.rect.x0||l.region.id===r.region.id)continue
   let rect=overlap(l.rect,r.rect);if(!rect)continue
   let gate:number|undefined
   if(l.region.compartment!==r.region.compartment){
    if(l.axis==='x'&&l.plane===wellRight&&l.region.compartment==='WELL'&&r.region.compartment==='CANAL')gate=0
    else if(l.axis==='x'&&l.plane===poolLeft&&l.region.compartment==='CANAL'&&r.region.compartment==='POOL')gate=1
    else if(!(l.axis==='z'&&(l.region.compartment==='LOWER'&&r.region.compartment==='ACTIVE'
     ||l.region.compartment==='ACTIVE'&&r.region.compartment==='UPPER'||l.region.compartment==='UPPER'&&r.region.compartment==='WELL')))continue
    if(gate!==undefined){rect=overlap(rect,{x0:-g.width_m/2,x1:g.width_m/2,y0:g.sills_m[gate]!,y1:g.top_m});if(!rect)continue}
   }
   const radius=l.radius===undefined?r.radius:r.radius===undefined?l.radius:Math.min(l.radius,r.radius),A=area(rect,radius)
   if(A===0)continue
   const base={left:l.region.id,right:r.region.id,leftDistance_m:l.distance,rightDistance_m:r.distance,axis:l.axis,plane_m:l.plane,
    meanOutwardNormal:(l.axis==='x'?[1,0,0]:l.axis==='y'?[0,1,0]:[0,0,1]) as [number,number,number]}
   consume(l,A);consume(r,A)
   if(gate!==undefined){
    const covered=overlap(rect,{x0:-g.width_m/2+travel_m[gate]!,x1:g.width_m/2+travel_m[gate]!,y0:g.sills_m[gate]!,y1:g.top_m}),Ac=covered?area(covered,radius):0
    gateArea+=A;gateCoveredArea+=Ac
    if(Ac>0)addFace({...base,area_m2:Ac,support:{id:gate===0?'GATE.WELL':'GATE.POOL',kind:'transfer-gate'}})
    if(A>Ac)addFace({...base,area_m2:A-Ac})
   }else{
    const inside=l.region.part==='inside'?l:r.region.part==='inside'?r:undefined,
     outside=inside===l?r:l
    if(l.axis!=='z'&&inside&&inside.region.rackId===outside.region.rackId&&outside.region.part!=='whole'){
     const covered=overlap(rect,{x0:rect.x0,x1:rect.x1,y0:p.panelSupport_m.bottom,y1:p.panelSupport_m.top}),Ac=covered?area(covered):0,
      direction=outside.region.part!
     if(Ac>0){addFace({...base,area_m2:Ac,support:{id:`${inside.region.rackId}/${direction}`,kind:'rack-panel'}});panelArea+=Ac}
     if(A>Ac)addFace({...base,area_m2:A-Ac})
    }else addFace({...base,area_m2:A})
   }
  }
 }
 let residualArea=0
 for(const f of facets){const shared=used.get(f.id)??0,remaining=f.area-shared,tolerance=64*Number.EPSILON*Math.max(f.area,shared)
  if(remaining < -tolerance)throw Error('Shared patches overlap or exceed source facet')
  // Area summation roundoff is accounted separately, never installed as a tiny
  // invented leak/reflector. This is geometric arithmetic, not stock admission.
  if(Math.abs(remaining)<=tolerance){residualArea+=remaining;continue}
  addFace({left:f.region.id,area_m2:remaining,leftDistance_m:f.distance,axis:f.axis,plane_m:f.plane,
   meanOutwardNormal:f.axis==='x'?[f.side,0,0]:f.axis==='y'?[0,f.side,0]:[0,0,f.side]})
 }
 const accounted=new Map<string,number>(),vectors=new Map<string,number[]>()
 for(const f of faces){
  for(const [id,sign] of [[f.left,1],...(f.right?[[f.right,-1] as const]:[])] as const){
   accounted.set(id,(accounted.get(id)??0)+f.area_m2)
   const v=vectors.get(id)??[0,0,0];for(let k=0;k<3;k++)v[k]=v[k]!+sign*f.area_m2*f.meanOutwardNormal[k]!
   vectors.set(id,v)
  }
 }
 let maxSurfaceDefect=0,maxVectorDefect=0
 for(const [id,A] of surface){const defect=Math.abs(A-(accounted.get(id)??0));maxSurfaceDefect=Math.max(maxSurfaceDefect,defect)
  if(defect>1e-10*A)throw Error('Region face ownership does not close')}
 for(const r of p.regions)if(r.box){const v=vectors.get(r.id);if(!v)throw Error('Missing region boundary')
  const defect=Math.hypot(...v);maxVectorDefect=Math.max(maxVectorDefect,defect)
  if(defect>1e-10*surface.get(r.id)!)throw Error('Literal region area-vector boundary does not close')}
 const expectedGateArea=g.width_m*(2*g.top_m-g.sills_m[0]-g.sills_m[1])
 if(Math.abs(gateArea-expectedGateArea)>1e-10*expectedGateArea)throw Error('True gate aperture is not fully represented')
 return {faces,gateArea_m2:gateArea,gateCoveredArea_m2:gateCoveredArea,panelArea_m2:panelArea,
  maximumRegionSurfaceDefect_m2:maxSurfaceDefect,areaSummationResidual_m2:residualArea,
  maximumLiteralRegionAreaVectorDefect_m2:maxVectorDefect,
  scope:'Complete geometric shared/escape faces and actual-pose optical supports only; nonorthogonal TPFA reduction. No current target/attenuation, material/heat/converter projection, coefficient operator, calibration or neutron advancement.'}
}
if(import.meta.main){
 const [partitionPath,gateOwner,first,second,output]=Bun.argv.slice(2)
 if(!partitionPath||!gateOwner||first===undefined||second===undefined||!output)throw Error('Usage: bun reference-design-source-faces.ts <partition receipt> <gate owner.md> <WELL travel m> <POOL travel m> <NEW receipt.json>')
 const partitionBytes=await Bun.file(partitionPath).text(),gateBytes=await Bun.file(gateOwner).text(),p=facePartitionSchema.parse(JSON.parse(partitionBytes).result),
  g=parseTransferGates(gateBytes),travel=[Number(first),Number(second)] as const,begin=performance.now(),result=compileSourceFaces(p,g,travel),
  hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 await writeFile(output,JSON.stringify({result,elapsedSeconds:(performance.now()-begin)/1000,travel_m:travel,
  partitionSHA256:hash(partitionBytes),gateOwnerSHA256:hash(gateBytes),sourceSHA256:hash(await Bun.file(import.meta.path).text()),
  geometryHelperSHA256:hash(await Bun.file(new URL('./reference-design-source-partition.ts',import.meta.url)).text()),
  gateHelperSHA256:hash(await Bun.file(new URL('./reference-design-fuel-transfer.ts',import.meta.url)).text())},null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({receipt:output,faces:result.faces.length,gateArea:result.gateArea_m2,covered:result.gateCoveredArea_m2,panelArea:result.panelArea_m2}))
}
