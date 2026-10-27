import type { PackPhysicalScene } from '../../../../core/packs/scene.ts'
import type { PhysicalPlanDrawing, PhysicalPlanPrimitive } from '../../../../core/packs/plan-drawing.ts'
import { compilePlanAnnotations } from '../architecture/compile-scene.ts'
import { elementWorld, parameters, type Source, type Element } from './source.ts'
import { createPlanWriter, planStyles as S, unionBounds, type V2, type Command, type Paint, type Membership } from './primitives.ts'
import { drawEquipmentPlan } from './family-plan.ts'
import { drawPhysicalPlanSections } from './section-plan.ts'

const ring=(x:number,y:number,w:number,h:number):Command[]=>[['M',x,y],['L',x+w,y],['L',x+w,y+h],['L',x,y+h],['Z']]
const dims=(value:number,unit:'m'|'mm')=>unit==='mm'?`${new Intl.NumberFormat('en',{maximumFractionDigits:0,useGrouping:true}).format(value*1000).replaceAll(',',' ')} mm`:`${new Intl.NumberFormat('en',{maximumFractionDigits:2}).format(value)} m`

/** A complete explicit floor drawing. Every primitive retains its occurrence,
 * level, scope, purpose and source-derived envelope; 3D triangles are not ink. */
export const compilePlanDrawing=(source:Source,scene:PackPhysicalScene):PhysicalPlanDrawing=>{
 const elements=new Map(source.elements.map(e=>[e.id,e])),objects=new Map(scene.objects.map(o=>[o.id,o])),unit=source.planIntent?.dimensionUnit??'m'
 const place=(element:Element)=>(p:V2):V2=>{const pose=elementWorld(source,element),c=Math.cos(pose.yaw),s=Math.sin(pose.yaw);return[pose.position[0]+c*p[0]-s*p[1]-source.origin[0],pose.position[1]+s*p[0]+c*p[1]-source.origin[1]]}
 const membership=(element:Element,depiction:Membership['depiction']='projection',suffix=''):Membership=>({id:`draft/${element.id}${suffix}`,...(objects.has(element.id)?{occurrenceId:element.id}:{}),scopeIds:objects.get(element.id)?.scopeIds??[source.rootScope.id,element.buildingId,...(['building','space','assembly'].includes(element.kind)?[element.id]:[])].filter((v):v is string=>v!==undefined),depiction,...(element.layerId?{layerId:element.layerId}:{})})
 const available=(element:Element,levelId:string)=>element.disposition!=='removed'&&(element.levelId==='site'||((objects.get(element.id)?.levelIds?.includes(levelId)??element.levelId===levelId)||source.planIntent?.contexts.some(c=>c.elementId===element.id&&c.depiction==='projection'&&c.levelIds.includes(levelId))))
 const writer=(output:PhysicalPlanPrimitive[],element:Element,depiction:Membership['depiction']='projection',suffix='')=>createPlanWriter(output,membership(element,depiction,suffix),place(element),elementWorld(source,element).yaw*180/Math.PI)
 const views=source.levels.map(level=>{
  const out:PhysicalPlanPrimitive[]=[],floor=level.id,cut=level.elevation+level.cutHeight
  // Floors own their actual voids. Panel joints are clipping-derived strokes,
  // never tessellation boundaries or a new solid covering the machinery.
  for(const e of source.elements.filter(e=>e.kind==='slab'&&e.levelId===floor&&e.disposition!=='removed')){
    const d=parameters(source,e),w=writer(out,e),commands=ring(0,0,d.length,d.width)
    for(const hole of e.holes??[])commands.push(...ring(hole.x,hole.y,hole.length,hole.width))
    w.path(commands,e.planSymbol==='hatch'?{fill:'paper',fillRule:'evenodd',stroke:'context-line',width:.045,dash:[.25,.15]}:{fill:'floor',fillRule:'evenodd'})
    if(e.planSymbol==='hatch'){for(const offset of e.surfaceJoints?.offsets??[])w.line(offset,0,offset,d.width,S.fine);w.text(d.length/2,d.width/2,e.planTag??e.label,.54)}
    const spacing=source.planIntent?.floorJoints.find(value=>value.elementId===e.id)?.spacing
    if(spacing)for(const axis of [0,1]as const){const across=axis===0?d.length:d.width,along=axis===0?d.width:d.length
      for(let at=spacing[axis];at<across;at+=spacing[axis]){
        const gaps=(e.holes??[]).filter(h=>at>(axis===0?h.x:h.y)&&at<(axis===0?h.x+h.length:h.y+h.width)).map(h=>[axis===0?h.y:h.x,axis===0?h.y+h.width:h.x+h.length]as V2).sort((a,b)=>a[0]-b[0])
        let start=0;for(const[a,b]of [...gaps,[along,along]as V2]){if(a>start)axis===0?w.line(at,start,at,a,{stroke:'floor-joint',width:.025}):w.line(start,at,a,at,{stroke:'floor-joint',width:.025});start=Math.max(start,b)}
      }
    }
  }
  // Only explicitly authored cross-level context appears on another floor.
  for(const context of source.planIntent?.contexts.filter(item=>item.depiction!=='projection'&&item.levelIds.includes(floor))??[]){
    const e=elements.get(context.elementId)!,d=parameters(source,e),w=writer(out,e,context.depiction,`/${context.depiction}`)
    w.rect(0,0,d.length,d.width,{stroke:'context-line',width:.045,dash:[.38,.22]});w.line(0,0,d.length,d.width,S.context);w.line(d.length,0,0,d.width,S.context)
  }
  for(const stroke of source.planIntent?.strokes.filter(item=>item.levelIds.includes(floor))??[]){const e=elements.get(stroke.elementId)!,points=e.member?.kind==='tube'?e.member.points:e.path;if(!points)throw Error(`An authored plan stroke has no source route: ${e.id}`);writer(out,e,'projection','/stroke').path(points.map((p,i)=>[i?'L':'M',p[0],p[1]]as Command),{stroke:stroke.material,width:stroke.width})}
  // Outdoor features retain their authored outline, not tall opaque blocks.
  for(const e of source.elements.filter(e=>e.levelId==='site'&&e.disposition!=='removed')){
    const d=parameters(source,e),w=writer(out,e)
    if(e.kind==='pavement'&&e.surface){for(const polygon of e.surface){const commands=polygon.flatMap(loop=>{const p=loop.map(v=>[v[0]-source.origin[0],v[1]-source.origin[1]]as V2);return[['M',...p[0]!],...p.slice(1).map(point=>['L',...point]),['Z']]as Command[]});createPlanWriter(out,membership(e)).path(commands,{fill:'pavement',fillRule:'evenodd',stroke:'muted',width:.045})}}
    else if(e.kind==='fence'||e.kind==='conductor'){if(e.path)createPlanWriter(out,membership(e)).path(e.path.map((p,i)=>[i?'L':'M',p[0]-source.origin[0],p[1]-source.origin[1]]as Command),{stroke:e.kind==='fence'?'muted':'crane',width:.06,...(e.kind==='fence'?{dash:[.2,.2]}:{})})}
    else if(e.kind==='equipment')drawEquipmentPlan(out,membership(e),e.equipmentKind!,d.length,d.width,place(e),e.pose.yaw*180/Math.PI,e.foundation)
    else if(e.kind==='context')w.rect(0,0,d.length,d.width,{fill:e.material??'ground',stroke:'muted',width:.035})
  }
  // Grid axes and chained dimensions refer to actual column/space authorities.
  for(const grid of source.planIntent?.grids.filter(g=>g.levelIds.includes(floor))??[]){
    const b=elements.get(grid.buildingId)!,space=elements.get(grid.spaceId)!,d=parameters(source,b),s=parameters(source,space),pose=elementWorld(source,b),c=Math.cos(pose.yaw),sn=Math.sin(pose.yaw)
    const local=(e:Element,p:V2):V2=>{const q=place(e)(p),x=q[0]+source.origin[0]-pose.position[0],y=q[1]+source.origin[1]-pose.position[1];return[c*x+sn*y,-sn*x+c*y]}
    const base:Membership={id:`grid/${grid.id}`,scopeIds:[source.rootScope.id,b.id],depiction:'annotation',layerId:'plan-grid'}
    const w=createPlanWriter(out,base,place(b),pose.yaw*180/Math.PI),dimension=createPlanWriter(out,{...base,id:base.id+'/dimension',layerId:'plan-dimensions'},place(b),pose.yaw*180/Math.PI)
    const dim=(a:V2,z:V2,offset:V2)=>{const A:[number,number]=[a[0]+offset[0],a[1]+offset[1]],B:[number,number]=[z[0]+offset[0],z[1]+offset[1]],length=Math.hypot(z[0]-a[0],z[1]-a[1]);dimension.line(...a,...A,{stroke:'dimension',width:.025});dimension.line(...z,...B,{stroke:'dimension',width:.025});dimension.line(...A,...B,{stroke:'dimension',width:.035});for(const p of[A,B])dimension.line(p[0]-.15,p[1]+.2,p[0]+.15,p[1]-.2,{stroke:'dimension',width:.035});dimension.text((A[0]+B[0])/2,(A[1]+B[1])/2-.34,dims(length,unit),.73,'dimension',a[0]===z[0]?-90:0,'middle','paper')}
    for(const direction of ['x','y']as const){const axes=grid.axes.filter(axis=>axis.axis===direction).map(axis=>{const e=elements.get(axis.elementId)!,size=parameters(source,e),p=local(e,[size.length*axis.fraction,size.width*axis.fraction]);return{...axis,value:p[direction==='x'?0:1]}}).sort((a,b)=>a.value-b.value)
      for(const axis of axes){if(direction==='x'){w.line(axis.value,-grid.bubbleOffset+.4,axis.value,d.width+.5,{stroke:'grid',width:.025,dash:[.55,.17,.07,.17]});w.ellipse(axis.value,-grid.bubbleOffset,.65,.65,{fill:'paper',stroke:'grid',width:.045});w.text(axis.value,-grid.bubbleOffset,axis.label,.67,'muted')}else{w.line(-grid.bubbleOffset+.4,axis.value,d.length+2,axis.value,{stroke:'grid',width:.025,dash:[.55,.17,.07,.17]});w.ellipse(-grid.bubbleOffset-.5,axis.value,.65,.65,{fill:'paper',stroke:'grid',width:.045});w.text(-grid.bubbleOffset-.5,axis.value,axis.label,.67,'muted')}}
      if(direction==='x')for(let i=1;i<axes.length;i++)dim([axes[i-1]!.value,0],[axes[i]!.value,0],[0,-grid.dimensionOffset])
    }
    const lower=local(space,[0,0]);dim(lower,[lower[0]+s.length,lower[1]],[0,-grid.overallOffset]);dim(lower,[lower[0],lower[1]+s.width],[d.length+4.3-lower[0],0])
  }
  for(const e of source.elements.filter(e=>available(e,floor)&&e.levelId!=='site')){
    const d=parameters(source,e),pose=elementWorld(source,e),w=writer(out,e),object=objects.get(e.id)
    if(e.kind==='wall'){
      const projected=new Set(source.planIntent?.projectedOpenings.filter(o=>o.levelIds.includes(floor)).map(o=>o.elementId))
      const holes=source.elements.filter(o=>o.kind==='opening'&&o.hostId===e.id&&(projected.has(o.id)||elementWorld(source,o).position[2]<=cut&&elementWorld(source,o).position[2]+parameters(source,o).height>cut)).map(o=>{const size=parameters(source,o);return{x:Math.max(0,o.pose.position[0]),y:Math.max(0,o.pose.position[1]),right:Math.min(d.length,o.pose.position[0]+size.length),bottom:Math.min(d.width,o.pose.position[1]+size.width)}}).filter(h=>h.right>h.x&&h.bottom>h.y)
      if(e.shape?.kind==='cylindrical-shell'){const outer=writer(out,e,'section'),rx=d.length/2,ry=d.width/2;outer.ellipse(rx,ry,rx,ry,S.wall);outer.ellipse(rx,ry,rx-e.shape.thickness,ry-e.shape.thickness,{fill:'floor',stroke:'cut',width:.02})}
      else{const xs=[...new Set([0,d.length,...holes.flatMap(h=>[h.x,h.right])])].sort((a,b)=>a-b),ys=[...new Set([0,d.width,...holes.flatMap(h=>[h.y,h.bottom])])].sort((a,b)=>a-b);for(let x=1;x<xs.length;x++)for(let y=1;y<ys.length;y++){const a=xs[x-1]!,b=xs[x]!,c=ys[y-1]!,z=ys[y]!,cx=(a+b)/2,cy=(c+z)/2;if(!holes.some(h=>cx>h.x&&cx<h.right&&cy>h.y&&cy<h.bottom))w.rect(a,c,b-a,z-c,S.wall)}}
      continue
    }
    if(e.kind==='opening'){
      if(source.planIntent?.projectedOpenings.some(o=>o.elementId===e.id&&o.levelIds.includes(floor))){w.rect(0,0,d.length,d.width,{fill:'paper',stroke:'waterbox',width:.045});for(let x=1.4;x<d.length;x+=1.4)w.line(x,0,x,d.width,{stroke:'equipment-line',width:.085});w.line(0,d.width*.25,d.length,d.width*.25,{stroke:'waterbox',width:.045});w.line(0,d.width*.75,d.length,d.width*.75,{stroke:'waterbox',width:.045})}continue
    }
    if(e.kind==='equipment'){drawEquipmentPlan(out,membership(e),e.equipmentKind!,d.length,d.width,place(e),pose.yaw*180/Math.PI,e.foundation);continue}
    if(e.planSymbol==='bearing'){w.rect(0,0,d.length,d.width,S.plinth,.09);w.rect(d.length*.175,d.width*.167,d.length*.65,d.width*.666,S.bearing,.12);w.line(d.length*.225,d.width/2,d.length*.775,d.width/2,S.center);continue}
    if(e.kind==='door'){
      const angle=e.door?.swing??Math.PI/2,r=d.length,open=e.planDoorPose==='open',end:V2=open?[r,0]:[r*Math.cos(angle),r*Math.sin(angle)],segments=Math.ceil(Math.abs(angle)/(Math.PI/2)),start=open?-angle:0
      w.line(0,0,...end,{stroke:'equipment-line',width:.11});const commands:Command[]=[['M',r*Math.cos(start),r*Math.sin(start)]]
      for(let i=0;i<segments;i++){const a=start+i*angle/segments,b=start+(i+1)*angle/segments,k=4/3*Math.tan((b-a)/4);commands.push(['C',r*(Math.cos(a)-k*Math.sin(a)),r*(Math.sin(a)+k*Math.cos(a)),r*(Math.cos(b)+k*Math.sin(b)),r*(Math.sin(b)-k*Math.cos(b)),r*Math.cos(b),r*Math.sin(b)])}w.path(commands,{stroke:'rib',width:.04});continue
    }
    if(e.kind==='stair'&&e.stair){w.rect(0,0,d.length,d.width,{fill:'paper',stroke:'equipment-line',width:.05});const run=d.width-e.stair.landingDepth*2,steps=Math.ceil(run/e.stair.minTread);for(let i=0;i<=steps;i++){const y=e.stair.landingDepth+run*i/steps;w.line(.2,y,e.stair.flightWidth,y,S.rib);w.line(d.length-e.stair.flightWidth,y,d.length-.2,y,S.rib)}w.line(e.stair.flightWidth+.15,e.stair.landingDepth,e.stair.flightWidth+.15,d.width-e.stair.landingDepth,{stroke:'equipment-line',width:.055});w.line(d.length-e.stair.flightWidth-.15,e.stair.landingDepth,d.length-e.stair.flightWidth-.15,d.width-e.stair.landingDepth,{stroke:'equipment-line',width:.055});w.text(d.length/2,.85,`S · ${floor===e.levelId?'UP':'DN'}`,.65);continue}
    if(e.kind==='support'&&e.member?.kind==='i-section'&&e.member.axis==='z'){const t=e.member.flange,a=(d.length-e.member.web)/2,b=a+e.member.web;w.path([['M',0,0],['L',d.length,0],['L',d.length,t],['L',b,t],['L',b,d.width-t],['L',d.length,d.width-t],['L',d.length,d.width],['L',0,d.width],['L',0,d.width-t],['L',a,d.width-t],['L',a,t],['L',0,t],['Z']],S.column);continue}
    if((e.kind==='support'||e.kind==='context')&&!e.member&&object&&object.bounds!.min[2]+source.origin[2]<=cut&&object.bounds!.max[2]+source.origin[2]>(e.planDisplay==='section'?cut:level.elevation))w.rect(0,0,d.length,d.width,S.plinth)
    if(e.kind==='pipe'&&e.path){createPlanWriter(out,membership(e)).path(e.path.map((p,i)=>[i?'L':'M',p[0]-source.origin[0],p[1]-source.origin[1]]as Command),{stroke:e.material??'pipe',width:.13})}
  }
  // Existing typed annotations are preserved as source facts and compiled into
  // the ordered drawing, rather than painted twice by unrelated overlays.
  for(const annotation of compilePlanAnnotations(source).filter(a=>a.levelIds.includes(floor)||a.levelIds.includes('site'))){
    const labelOverride=source.planIntent?.labelPositions.find(value=>value.annotationId===annotation.id)
    if(annotation.kind==='label'&&labelOverride?.visible===false)continue
    const w=createPlanWriter(out,{id:`draft/annotation/${annotation.id}`,scopeIds:annotation.scopeIds,depiction:annotation.kind==='hatch'?'allowance':'annotation',...(annotation.occurrenceId?{occurrenceId:annotation.occurrenceId}:{}),...(annotation.layerId?{layerId:annotation.layerId}:{})})
    if(annotation.kind==='label'){const e=annotation.occurrenceId?elements.get(annotation.occurrenceId):undefined,authored=source.planAnnotations?.find(a=>a.id===annotation.id),override=source.planIntent?.labelPositions.find(value=>value.annotationId===annotation.id),text=e?.planTag??annotation.text;const natural=annotation.role==='space'?1:annotation.role==='equipment'?1.1:.65;const fitted=e&&authored?.kind==='label'&&!authored.text&&!e.planTag?Math.min(.65,parameters(source,e).length/(text.length*1.2)):natural;w.text(override?.anchor?override.anchor[0]-source.origin[0]:annotation.anchor[0],override?.anchor?override.anchor[1]-source.origin[1]:annotation.anchor[1],text,override?.height??fitted,annotation.role==='equipment'?'equipment-line':'muted',annotation.rotation,'middle','paper')}
    else if(annotation.kind==='hatch'){const p=annotation.outline.map(v=>[v[0],v[1]]as V2);w.path([['M',...p[0]!],...p.slice(1).map(p=>['L',...p]as Command),['Z']],{stroke:annotation.role==='access'?'access':'outage',width:.05,dash:[.35,.18],hatch:{material:annotation.role==='access'?'access':'outage',spacing:.6,width:.025,angle:45}});const box=unionBounds([{min:[Math.min(...p.map(p=>p[0])),Math.min(...p.map(p=>p[1]))],max:[Math.max(...p.map(p=>p[0])),Math.max(...p.map(p=>p[1]))]}]);const labelAt=labelOverride?.anchor;if(labelOverride?.visible!==false)w.text(labelAt?labelAt[0]-source.origin[0]:(box.min[0]+box.max[0])/2,labelAt?labelAt[1]-source.origin[1]:(box.min[1]+box.max[1])/2,annotation.label,.76,annotation.role==='access'?'access':'outage')}
    else{const a:V2=[annotation.from[0],annotation.from[1]],b:V2=[annotation.to[0],annotation.to[1]],c:V2=[a[0]+annotation.offset[0],a[1]+annotation.offset[1]],d:V2=[b[0]+annotation.offset[0],b[1]+annotation.offset[1]];w.line(...a,...c,{stroke:'dimension',width:.025});w.line(...b,...d,{stroke:'dimension',width:.025});w.line(...c,...d,{stroke:'dimension',width:.035});for(const p of[c,d])w.line(p[0]-.15,p[1]+.2,p[0]+.15,p[1]-.2,{stroke:'dimension',width:.035});w.text((c[0]+d[0])/2,(c[1]+d[1])/2-.34,dims(Math.hypot(b[0]-a[0],b[1]-a[1]),unit),.73,'dimension',a[0]===b[0]?-90:0,'middle','paper')}
  }
  drawPhysicalPlanSections(source,scene,floor,out)
  return{levelId:floor,bounds:unionBounds(out.map(p=>p.bounds)),primitives:out}
 })
 return{views}
}
