import type {PackPhysicalScene,PhysicalSceneObject} from '../../../../core/packs/scene.ts'
import type {PhysicalPlanPrimitive} from '../../../../core/packs/plan-drawing.ts'
import type {Source} from './source.ts'
import {createPlanWriter,type V2} from './primitives.ts'
type Box={min:V2;max:V2}
/** Project an actual semantic mesh part into the section's horizontal/vertical
 * coordinates. Dimensions follow accepted solids, never another rectangle model. */
const part=(object:PhysicalSceneObject,axis:number,roles?:ReadonlyArray<string>):Box|null=>{const min:V2=[Infinity,Infinity],max:V2=[-Infinity,-Infinity];for(let v=0;v<object.positions.length/3;v++){if(roles&&!roles.includes(object.materials?.[object.materialIndices?.[v]??-1]??object.material??''))continue;for(const[i,coordinate]of[object.positions[v*3+axis]!,object.positions[v*3+2]!] .entries()){min[i as 0|1]=Math.min(min[i as 0|1],coordinate);max[i as 0|1]=Math.max(max[i as 0|1],coordinate)}}return min.every(Number.isFinite)?{min,max}:null}
const spanAt=(object:PhysicalSceneObject,axis:number,role:string,elevation:number):V2=>{const values:number[]=[];for(let vertex=0;vertex<object.positions.length/3;vertex++)if(object.positions[vertex*3+2]===elevation&&(object.materials?.[object.materialIndices?.[vertex]??-1]??object.material)===role)values.push(object.positions[vertex*3+axis]!);if(!values.length)throw Error(`A section part has no source vertices at its own elevation: ${object.id}/${role}`);return[Math.min(...values),Math.max(...values)]}
/** Source-derived schematic section: distinct LP casings, exhaust necks,
 * condenser shells/tube banks, piers and true floor datums retain drawing roles.
 * This remains explicitly conceptual, not a qualified engineering section. */
export const drawPhysicalPlanSections=(source:Source,scene:PackPhysicalScene,levelId:string,output:PhysicalPlanPrimitive[])=>{
 const objects=new Map(scene.objects.map(object=>[object.id,object])),elements=new Map(source.elements.map(element=>[element.id,element]))
 for(const section of source.planIntent?.sections?.filter(section=>section.levelIds.includes(levelId))??[]){
  const selected=section.elementIds.map(id=>{const object=objects.get(id);if(!object)throw Error(`A section authority has no physical solid: ${section.id}/${id}`);return object})
  const axis=section.horizontalAxis==='x'?0:1,low=Math.min(...selected.map(object=>object.bounds!.min[axis]!)),high=Math.max(...selected.map(object=>object.bounds!.max[axis]!)),floors=section.floorIds.map(id=>source.levels.find(level=>level.id===id)!),bottom=Math.min(...floors.map(floor=>floor.elevation-source.origin[2]),...selected.map(object=>object.bounds!.min[2])),top=Math.max(...selected.map(object=>object.bounds!.max[2])),vertical=section.verticalScale??section.scale,width=(high-low)*section.scale,height=(top-bottom)*vertical,at:V2=[section.anchor[0]-source.origin[0],section.anchor[1]-source.origin[1]],paperY=source.northAxis==='negative-y'?1:-1,w=createPlanWriter(output,{id:`draft/section/${section.id}`,scopeIds:section.scopeIds,depiction:'annotation',layerId:'plan-labels'},point=>[at[0]+point[0],at[1]+paperY*point[1]])
  const X=(x:number)=>(x-low)*section.scale,Y=(z:number)=>(top-z)*vertical
  const rect=(box:Box,paint:Parameters<typeof w.rect>[4],radius=0)=>w.rect(X(box.min[0]),Y(box.max[1]),(box.max[0]-box.min[0])*section.scale,(box.max[1]-box.min[1])*vertical,paint,radius)
  w.rect(-.7,-4.5,width+8,height+6.5,{fill:'paper'})
  w.text(0,-3.5,`${section.label} / LEVEL RELATIONSHIP`,.8,'equipment-line',0,'start')
  w.text(0,-2.2,'Schematic section · heights are study assumptions',.63,'muted',0,'start')
  // Piers sit behind the machinery. Coincident front/back projections share one
  // drawn silhouette; operational identity stays on the actual floor occurrence.
  const seen=new Set<string>()
  for(const object of selected.filter(object=>object.kind!=='equipment')){const box=part(object,axis)!;const key=JSON.stringify(box);if(seen.has(key))continue;seen.add(key);rect(box,{fill:'steel',stroke:'rib',width:.035})}
  const condensers=selected.filter(object=>elements.get(object.id)?.equipmentKind==='condenser')
  for(const object of condensers){const shell=part(object,axis,['machine'])??part(object,axis)!,neck=part(object,axis,['hood']);rect(shell,{fill:'hood',stroke:'equipment-line',width:.055},.2)
   const dx=(shell.max[0]-shell.min[0])*.2,dz=(shell.max[1]-shell.min[1])*.15,bank:Box={min:[shell.min[0]+dx,shell.min[1]+dz],max:[shell.max[0]-dx,shell.max[1]-dz]};rect(bank,{stroke:'rib',width:.04,hatch:{material:'rib',spacing:.35,width:.035,angle:paperY*90}})
   if(neck){const lower=spanAt(object,axis,'hood',neck.min[1]),upper=spanAt(object,axis,'hood',neck.max[1]);w.path([['M',X(lower[0]),Y(neck.min[1])],['L',X(lower[1]),Y(neck.min[1])],['L',X(upper[1]),Y(neck.max[1])],['L',X(upper[0]),Y(neck.max[1])],['Z']],{stroke:'rib',width:.045,dash:[.25,.15],hatch:{material:'rib',spacing:.5,width:.025,angle:paperY*-45}})}
  }
  const exhausts=selected.filter(object=>elements.get(object.id)?.equipmentKind==='lp')
  for(const object of exhausts){const foundation=part(object,axis,['plinth']),body=part(object,axis,['machine','hood'])??part(object,axis)!;if(foundation)rect(foundation,{fill:'plinth',stroke:'rib',width:.035});rect(body,{fill:'machine',stroke:'equipment-line',width:.07},Math.min((body.max[0]-body.min[0])*section.scale*.16,(body.max[1]-body.min[1])*vertical*.3));const hood=part(object,axis,['hood']);if(hood){const center=(hood.min[0]+hood.max[0])/2,y=Y(hood.max[1]),r=(hood.max[0]-hood.min[0])*section.scale*.38;w.path([['M',X(center)-r,Y(hood.min[1])],['Q',X(center),y-r*.25,X(center)+r,Y(hood.min[1])]],{stroke:'rib',width:.04})}}
  for(const object of selected.filter(object=>object.kind==='equipment'&&!['lp','condenser'].includes(elements.get(object.id)?.equipmentKind??'')))rect(part(object,axis)!,{fill:'machine',stroke:'equipment-line',width:.055},.2)
  for(const floor of floors){const z=floor.elevation-source.origin[2],y=Y(z);w.line(0,y,width+6,y,{stroke:'dimension',width:floor.elevation===Math.min(...floors.map(f=>f.elevation))?.08:.22});w.text(width+5.5,y-.65,`${floor.elevation===0?'±':floor.elevation>0?'+':''}${floor.elevation.toFixed(2)} m`,.78,'dimension',0,'end')}
  if(exhausts.length)w.text(width*.42,-.75,'LP EXHAUSTS',.6,'muted')
  if(condensers.length){const box=part(condensers.at(-1)!,axis)!,y=Y((box.min[1]+box.max[1])/2),x=X(box.max[0]);w.line(x-.3,y,x+3,y,{stroke:'context-line',width:.045});w.text(x+3.5,y+.15,'CONDENSER',.65,'muted',0,'start')}
  w.text(width*.45,height+1.5,'CONDENSERS BELOW THE DECK',.6,'muted')
 }
}
