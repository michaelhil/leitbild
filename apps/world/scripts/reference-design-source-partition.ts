/** Fixed LD-01 neutron-region GEOMETRY compiler. No coefficients, material-state
 * projection, face graph, eigenvalue calibration or neutron time advancement. */
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {fuelAssemblyPositions,fuelHandlingChecks,parseFuelHandling} from './reference-design-fuel-handling'
import {parseControlAbsorber} from './reference-design-control-absorber'
import {parseInitializationBasis} from './reference-design-initialization'
import {parsePrimaryBarrelGeometry,parsePrimaryMechanics} from './reference-design-primary-mechanics'

const schema=z.object({coreBands:z.number().int().positive()}).strict()
export function parseSourcePartition(document:string){
 const blocks=[...document.matchAll(/^```reference-source-partition\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one reference-source-partition block')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
export type Rectangle={x0:number,x1:number,y0:number,y1:number}
/** Analytic disk/rectangle intersection; cuts where the circular arcs cross a
 * rectangle edge. No raster sampling or nearest-cell allocation. */
export function diskRectangleArea(radius:number,box:Rectangle){
 if(![radius,...Object.values(box)].every(Number.isFinite)||radius<=0||box.x1<=box.x0||box.y1<=box.y0)
  throw Error('Invalid disk/rectangle geometry')
 const lo=Math.max(-radius,box.x0),hi=Math.min(radius,box.x1)
 if(hi<=lo||box.y1<=-radius||box.y0>=radius)return 0
 const cuts=[lo,hi]
 for(const y of [box.y0,box.y1])if(Math.abs(y)<radius){
  const x=Math.sqrt((radius-y)*(radius+y))
  for(const q of [-x,x])if(q>lo&&q<hi)cuts.push(q)
 }
 cuts.sort((a,b)=>a-b)
 const primitive=(x:number)=>.5*(x*Math.sqrt(Math.max(0,(radius-x)*(radius+x)))+radius**2*Math.asin(x/radius))
 let area=0
 for(let i=1;i<cuts.length;i++){
  const a=cuts[i-1]!,b=cuts[i]!,mid=(a+b)/2,s=Math.sqrt((radius-mid)*(radius+mid))
  if(Math.min(box.y1,s)<=Math.max(box.y0,-s))continue
  const arc=primitive(b)-primitive(a)
  const top=box.y1<s?box.y1*(b-a):arc,bottom=box.y0>-s?box.y0*(b-a):-arc
  area+=top-bottom
 }
 // Negative area is an implementation error, not an occupancy to clip/normalize.
 if(area<0||!Number.isFinite(area))throw Error('Disk intersection lost positivity')
 return area
}
type Region={id:string,compartment:'ACTIVE'|'LOWER'|'UPPER'|'WELL'|'CANAL'|'POOL',volume_m3:number,
 envelopeLength_m:number,box?:Rectangle,z0_m?:number,z1_m?:number,diskRadius_m?:number,rackId?:string,part?:string}
type Inputs={fuel:ReturnType<typeof parseFuelConstruction>,handling:ReturnType<typeof parseFuelHandling>,
 control:ReturnType<typeof parseControlAbsorber>,primary:ReturnType<typeof parsePrimaryMechanics>,
 barrel:ReturnType<typeof parsePrimaryBarrelGeometry>,initialization:ReturnType<typeof parseInitializationBasis>,
 partition:ReturnType<typeof parseSourcePartition>}
export function compileSourcePartition(d:Inputs){
 const {fuel:f,handling:h,control:c,primary:p,barrel:b}=d
 const fuelCheck=fuelHandlingChecks(h,f),assemblies=fuelAssemblyPositions(h,f)
 const pitch=f.latticeSide*f.pitch_m,activeBottom=h.seatedBottom_m+h.bottomFittingLength_m,
  activeTop=activeBottom+f.activeLength_m,downHeight=p.downcomerTop_m-p.downcomerBottom_m,
  downVolume=d.initialization.volumes_m3[0],radius=Math.sqrt(b.outerRadius_m**2+downVolume/(Math.PI*downHeight)),
  headTop=c.headBottom_m+c.headThickness_m,transferMid=h.transferBottom_m+h.bottomFittingLength_m+f.activeLength_m/2,
  rackBottom=h.poolFloor_m+h.bottomFittingLength_m,rackMid=rackBottom+f.activeLength_m/2,rackTop=rackBottom+f.activeLength_m,
  wellSide=Math.sqrt(h.wellArea_m2),wellX=wellSide/2,canalEnd=wellX+h.canalLength_m,
  poolEnd=canalEnd+h.poolSide_m,panelHalf=h.rackSleeveSide_m/2-h.rackSkin_m-fuelCheck.rack.matrixThickness_m/2
 if(!(b.innerRadius_m<b.outerRadius_m&&activeBottom>=p.downcomerBottom_m&&activeTop<=p.downcomerTop_m))
  throw Error('Source core/barrel/DOWN support is inconsistent')
 if(!(c.headBottom_m===h.wellFloor_m&&c.headGrossArea_m2<=h.wellArea_m2))throw Error('Head mouth does not fit well support')
 for(const width of [wellSide,h.canalLength_m,h.canalWidth_m,h.poolSide_m])
  if(Math.abs(width/h.rackPitch_m-Math.round(width/h.rackPitch_m))>1e-10)throw Error('Receiving pitch does not exactly tile owned bay')
 const regions:Region[]=[],counts:Record<string,number>={},racks:{id:string,x_m:number,y_m:number}[]=[]
 const cylinderEll=4*(Math.PI*radius**2*f.activeLength_m)/(2*Math.PI*radius*(radius+f.activeLength_m))
 const add=(r:Region)=>{
  if(!(r.volume_m3>0&&r.envelopeLength_m>0&&Number.isFinite(r.volume_m3+r.envelopeLength_m)))throw Error('Nonpositive source region')
  regions.push(r);counts[r.compartment]=(counts[r.compartment]??0)+1
 }
 const extent=Math.ceil(radius/pitch+.5)
 for(let y=-extent;y<=extent;y++)for(let x=-extent;x<=extent;x++){
  const box={x0:(x-.5)*pitch,x1:(x+.5)*pitch,y0:(y-.5)*pitch,y1:(y+.5)*pitch},area=diskRectangleArea(radius,box)
  if(area===0)continue
  for(let band=0;band<d.partition.coreBands;band++){
   const z0=activeBottom+f.activeLength_m*band/d.partition.coreBands,z1=activeBottom+f.activeLength_m*(band+1)/d.partition.coreBands
   add({id:`ACTIVE/${x}/${y}/${band}`,compartment:'ACTIVE',box,z0_m:z0,z1_m:z1,diskRadius_m:radius,
    volume_m3:area*(z1-z0),envelopeLength_m:cylinderEll})
  }
 }
 const coreInterface=Math.PI*b.innerRadius_m**2,lowerVolume=d.initialization.volumes_m3[1],upperVolume=d.initialization.volumes_m3[4]
 add({id:'LOWER',compartment:'LOWER',volume_m3:lowerVolume,envelopeLength_m:4*lowerVolume/(2*coreInterface)})
 add({id:'UPPER',compartment:'UPPER',volume_m3:upperVolume,envelopeLength_m:4*upperVolume/(coreInterface+c.headGrossArea_m2)})
 // Rack centres are immutable equipment locations. Five source pieces do not
 // create five material owners or shorten the pool's physical envelope length.
 const rackStartX=(canalEnd+poolEnd)/2-(h.rackSide-1)*h.rackPitch_m/2,
  rackStartY=-(h.rackSide-1)*h.rackPitch_m/2
 for(let y=0;y<h.rackSide;y++)for(let x=0;x<h.rackSide;x++)racks.push({id:`RACK/${x}/${y}`,x_m:rackStartX+x*h.rackPitch_m,y_m:rackStartY+y*h.rackPitch_m})
 const rackOffset=(h.poolSide_m/h.rackPitch_m-h.rackSide)/2
 if(!Number.isInteger(rackOffset)||rackOffset<0)throw Error('Rack tiles do not align with fixed pool partition')
 const bays=[{name:'WELL' as const,x0:-wellX,x1:wellX,y0:-wellX,y1:wellX,cuts:[h.wellFloor_m,headTop,transferMid,h.surface_m]},
  {name:'CANAL' as const,x0:wellX,x1:canalEnd,y0:-h.canalWidth_m/2,y1:h.canalWidth_m/2,cuts:[h.canalFloor_m,transferMid,h.surface_m]},
  {name:'POOL' as const,x0:canalEnd,x1:poolEnd,y0:-h.poolSide_m/2,y1:h.poolSide_m/2,cuts:[h.poolFloor_m,rackMid,rackTop,transferMid,h.surface_m]}]
 const headRadius=Math.sqrt(c.headGrossArea_m2/Math.PI),headPatches:{regionId:string,area_m2:number}[]=[]
 for(const bay of bays){
  if(!bay.cuts.every((q,i)=>i===0||q>bay.cuts[i-1]!))throw Error('Owned bay boundaries are not ordered')
  const width=bay.x1-bay.x0,depth=bay.y1-bay.y0,height=bay.cuts.at(-1)!-bay.cuts[0]!,
   ell=4*width*depth*height/(2*(width*depth+width*height+depth*height))
  for(let y=0;y<Math.round(depth/h.rackPitch_m);y++)for(let x=0;x<Math.round(width/h.rackPitch_m);x++){
   const box={x0:bay.x0+x*h.rackPitch_m,x1:bay.x0+(x+1)*h.rackPitch_m,y0:bay.y0+y*h.rackPitch_m,y1:bay.y0+(y+1)*h.rackPitch_m},
    cx=(box.x0+box.x1)/2,cy=(box.y0+box.y1)/2,
    rx=x-rackOffset,ry=y-rackOffset,rack=bay.name==='POOL'&&rx>=0&&ry>=0&&rx<h.rackSide&&ry<h.rackSide?racks[ry*h.rackSide+rx]:undefined
   for(let band=0;band<bay.cuts.length-1;band++){
    const z0=bay.cuts[band]!,z1=bay.cuts[band+1]!,parts=rack&&z0<rackTop&&z1>rackBottom?
     [{part:'inside',x0:cx-panelHalf,x1:cx+panelHalf,y0:cy-panelHalf,y1:cy+panelHalf},
      {part:'west',x0:box.x0,x1:cx-panelHalf,y0:box.y0,y1:box.y1},
      {part:'east',x0:cx+panelHalf,x1:box.x1,y0:box.y0,y1:box.y1},
      {part:'south',x0:cx-panelHalf,x1:cx+panelHalf,y0:box.y0,y1:cy-panelHalf},
      {part:'north',x0:cx-panelHalf,x1:cx+panelHalf,y0:cy+panelHalf,y1:box.y1}]:[{part:'whole',...box}]
    for(const {part,...rect} of parts){const id=`${bay.name}/${x}/${y}/${band}/${part}`
     add({id,compartment:bay.name,box:rect,z0_m:z0,z1_m:z1,volume_m3:(rect.x1-rect.x0)*(rect.y1-rect.y0)*(z1-z0),envelopeLength_m:ell,...(rack?{rackId:rack.id}:{}),part})
     if(bay.name==='WELL'&&band===0){const area=diskRectangleArea(headRadius,rect);if(area>0)headPatches.push({regionId:id,area_m2:area})}
    }
   }
  }
 }
 const volume=(name:string)=>regions.filter(r=>r.compartment===name).reduce((sum,r)=>sum+r.volume_m3,0)
 const expected={ACTIVE:Math.PI*radius**2*f.activeLength_m,LOWER:lowerVolume,UPPER:upperVolume,
  WELL:wellSide**2*(h.surface_m-h.wellFloor_m),CANAL:h.canalLength_m*h.canalWidth_m*(h.surface_m-h.canalFloor_m),POOL:h.poolSide_m**2*(h.surface_m-h.poolFloor_m)}
 const volumes=Object.entries(expected).map(([name,expected_m3])=>({compartment:name,expected_m3,compiled_m3:volume(name)}))
 if(volumes.some(q=>Math.abs(q.compiled_m3-q.expected_m3)>1e-10*q.expected_m3))throw Error('Source partition does not close owned compartment volumes')
 if(new Set(regions.map(r=>r.id)).size!==regions.length||racks.length!==h.rackSide**2)throw Error('Source/equipment identities not unique')
 const headArea=headPatches.reduce((sum,q)=>sum+q.area_m2,0)
 if(Math.abs(headArea-c.headGrossArea_m2)>1e-10*c.headGrossArea_m2)throw Error('Actual head mouth overlap incomplete')
 return {regions,assemblies,racks,counts,volumes,regionCount:regions.length,neutronCoordinates:7*regions.length,
  outerRadius_m:radius,headPatches,headArea_m2:headArea,corePlenumInterfaceArea_m2:coreInterface,
  representedDownVolume_m3:downVolume*f.activeLength_m/downHeight,
  uncreditedDownEndVolume_m3:downVolume*(1-f.activeLength_m/downHeight),
  panelSupport_m:{bottom: rackBottom,top:rackTop},
  scope:'Fixed geometric regions, immutable equipment positions and head-mouth area overlaps only. No shared-face/escape graph, optical patch incidence, current material/thermal projection, source coefficients, calibration or runtime admission.'}
}
if(import.meta.main){
 const [wiki,output]=Bun.argv.slice(2)
 if(!wiki||!output)throw Error('Usage: bun reference-design-source-partition.ts <LD-01 directory> <NEW receipt.json>')
 const files=['systems/reactor/fuel-construction.md','systems/reactor/fuel-handling-and-pool.md',
  'systems/reactor/control-absorber-and-guide-water.md','systems/primary-coolant/mechanical-energy-and-geometry.md',
  'systems/reactor/core-coolant-delivery.md','model/connected-primary-initialization.md','model/operating-source-model.md']
 const docs=await Promise.all(files.map(name=>Bun.file(join(wiki,name)).text())),hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 const input={fuel:parseFuelConstruction(docs[0]!),handling:parseFuelHandling(docs[1]!),control:parseControlAbsorber(docs[2]!),
  primary:parsePrimaryMechanics(docs[3]!),barrel:parsePrimaryBarrelGeometry(docs[4]!),initialization:parseInitializationBasis(docs[5]!),partition:parseSourcePartition(docs[6]!)}
 const began=performance.now(),result=compileSourcePartition(input),elapsedSeconds=(performance.now()-began)/1000
 const helpers=['reference-design-fuel-construction.ts','reference-design-fuel-handling.ts','reference-design-control-absorber.ts',
  'reference-design-initialization.ts','reference-design-primary-mechanics.ts']
 const helperIdentities=await Promise.all(helpers.map(async name=>({name,sha256:hash(await Bun.file(new URL(name,import.meta.url)).text())})))
 await writeFile(output,JSON.stringify({input,result,elapsedSeconds,sourceSHA256:hash(await Bun.file(import.meta.path).text()),helperIdentities,
  consumed:files.map((name,i)=>({name,sha256:hash(docs[i]!)}))},null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({receipt:output,counts:result.counts,regions:result.regionCount,neutronCoordinates:result.neutronCoordinates,elapsedSeconds}))
}
