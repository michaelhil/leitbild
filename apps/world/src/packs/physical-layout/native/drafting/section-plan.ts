import type {PackPhysicalScene} from '../../../../core/packs/scene.ts'
import type {PhysicalPlanPrimitive} from '../../../../core/packs/plan-drawing.ts'
import type {Source} from './source.ts'
import {createPlanWriter,type V2} from './primitives.ts'

/** A paper-space relationship diagram resolved from actual floor elevations and
 * equipment envelopes. It is explicitly schematic, never another physical model. */
export const drawPhysicalPlanSections=(source:Source,scene:PackPhysicalScene,levelId:string,output:PhysicalPlanPrimitive[])=>{
 const objects=new Map(scene.objects.map(object=>[object.id,object]))
 for(const section of source.planIntent?.sections?.filter(section=>section.levelIds.includes(levelId))??[]){
  const selected=section.elementIds.map(id=>objects.get(id)).filter(object=>object!==undefined)
  if(!selected.length)throw Error(`A section has no physical geometry: ${section.id}`)
  const axis=section.horizontalAxis==='x'?0:1,low=Math.min(...selected.map(object=>object.bounds!.min[axis]!)),high=Math.max(...selected.map(object=>object.bounds!.max[axis]!)),floors=section.floorIds.map(id=>source.levels.find(level=>level.id===id)!),bottom=Math.min(...floors.map(floor=>floor.elevation-source.origin[2]),...selected.map(object=>object.bounds!.min[2])),top=Math.max(...selected.map(object=>object.bounds!.max[2]))
  const width=(high-low)*section.scale,height=(top-bottom)*section.scale,at:V2=[section.anchor[0]-source.origin[0],section.anchor[1]-source.origin[1]],w=createPlanWriter(output,{id:`draft/section/${section.id}`,scopeIds:section.scopeIds,depiction:'annotation',layerId:'plan-labels'},point=>[at[0]+point[0],at[1]+point[1]])
  w.rect(-.65,-1.8,width+8,height+4.4,{fill:'paper',stroke:'context-line',width:.035})
  w.text(0,-.85,`${section.label} · SCHEMATIC LEVEL RELATIONSHIP`,.62,'muted',0,'start')
  const y=(z:number)=>(top-z)*section.scale
  for(const object of selected){const box=object.bounds!;w.rect((box.min[axis]!-low)*section.scale,y(box.max[2]),(box.max[axis]!-box.min[axis]!)*section.scale,(box.max[2]-box.min[2])*section.scale,{fill:object.kind==='equipment'?'machine':'plinth',stroke:'equipment-line',width:.04})}
  for(const floor of floors){const z=floor.elevation-source.origin[2],Y=y(z);w.line(-.3,Y,width+.4,Y,{stroke:'dimension',width:.065});w.text(width+.9,Y,`${floor.elevation>=0?'+':''}${floor.elevation.toFixed(3)} m`,.57,'dimension',0,'start')}
  w.text(width/2,height+1.6,'Envelope projection · not an engineering section',.48,'muted')
 }
}
