import{elementWorld,parameters,type Source,type Element,type V3}from'../native/drafting/source.ts'
import type{PhysicalSceneBounds}from'../../../core/packs/scene.ts'
import{localPointAtAnchor}from'../native/campus/author-campus.ts'
import{routePhysicalConnection,roundedPhysicalRoute,type RoutingObstacle}from'../native/routing/route.ts'
import type{PhysicalCoverageEvidence}from'../coverage.ts'
import arrangement from'../pwr-campus.arrangement.json'
import{physicalRouteSeparation}from'./route-separation.ts'
type Binding={physicalElementId:string;elementId:string;relation:'represents'|'partOf'|'houses'}
/** Explicit study installation dimensions. They describe physical assumptions,
 * not numerical transformer ratings or extra graph subjects. */
export const pwrExportPolicy={length:18,width:11,height:10,serviceClearance:12,lvDiameter:.44,clearance:.15,bendRadius:1.32,geometryTolerance:.01}

/** Campus owns the export installation, separately from the 80 MW unit auxiliary
 * service transformer. Related-member applicability pins the exact unit geometry
 * from which each generator terminal is derived. No process model is extended. */
export const authorPwrCampusExport=(source:Source,unit:Source,unitBounds:PhysicalSceneBounds,bindings:Binding[],coverage:PhysicalCoverageEvidence)=>{
 const q=pwrExportPolicy,generator=unit.elements.find(e=>e.id==='tg-generator')!,gd=parameters(unit,generator),gp=elementWorld(unit,generator)
 const north=(p:V3):V3=>[p[0]-unit.origin[0],(unit.northAxis==='negative-y'?-1:1)*(p[1]-unit.origin[1]),p[2]-unit.origin[2]]
 const generatorTip=(phase:number):V3=>{const x=gd.length*.45+.35+phase*.75,y=gd.width+1.6;return north([gp.position[0]+Math.cos(gp.yaw)*x-Math.sin(gp.yaw)*y,gp.position[1]+Math.sin(gp.yaw)*x+Math.cos(gp.yaw)*y,gp.position[2]+.8])}
 const typeId='type/campus/export-gsu';source.types.push({id:typeId,kind:'transformer',parameters:{length:q.length,width:q.width,height:q.height}})
 const add=(element:Element,subject:string|undefined,reason:string)=>{if(source.elements.some(e=>e.id===element.id))throw Error(`Duplicate campus export part: ${element.id}`);source.elements.push(element);if(subject){bindings.push({physicalElementId:element.id,elementId:subject,relation:'partOf'});const disposition=coverage.dispositions.find(d=>d.subjectId===subject);if(!disposition)throw Error(`Export installation has no exact grid subject: ${subject}`);disposition.physicalElementIds.push(element.id)}else coverage.contextElements.push({physicalElementId:element.id,reason})}
 for(const member of arrangement.units){
  const anchor=member.anchor as[number,number],project=(p:V3)=>localPointAtAnchor(arrangement.siteAnchor as[number,number],anchor,p),tip=generatorTip(1),position=project([unitBounds.max[0]+q.serviceClearance,tip[1]-q.width/2,0]),assemblyId=`assembly/${member.role}/export-gsu`,bodyId=`equipment/${member.role}/export-gsu`
  const common={levelId:'site',disposition:'installed' as const,assemblyId}
  const box=(id:string,label:string,kind:Element['kind'],p:V3,length:number,width:number,height:number,extra:Partial<Element>={}):Element=>({id,label,kind,pose:{position:p,yaw:0},dimensions:{length,width,height},...common,...extra})
  add(box(assemblyId,`${member.label} generator step-up export installation`,'assembly',[position[0]-2,position[1]-2,0],q.length+4,q.width+5,q.height,{assemblyId:undefined}),undefined,'Campus-owned physical export assembly; one existing Grid export subject owns its installation. No extra process component or operational reading is invented.')
  add({id:bodyId,label:`${member.label} generator step-up transformer · illustrative aggregate export`,kind:'equipment',pose:{position,yaw:0},typeId,equipmentKind:'transformer',...common},member.subjectId,'')
  add(box(`pad/${member.role}/export-gsu`,`${member.label} export-transformer foundation`,'slab',[position[0]-2,position[1]-2,-.3],q.length+4,q.width+5,.3),undefined,'Illustrative export-transformer foundation and service allowance, separate from the unit auxiliary transformer.')
  const obstacles:RoutingObstacle[]=unit.elements.filter(e=>e.kind==='building').map(e=>{const d=parameters(unit,e),p=elementWorld(unit,e),corners=[[0,0],[d.length,0],[d.length,d.width],[0,d.width]].map(([x,y])=>project(north([p.position[0]+Math.cos(p.yaw)*x!-Math.sin(p.yaw)*y!,p.position[1]+Math.sin(p.yaw)*x!+Math.cos(p.yaw)*y!,p.position[2]])));return{id:e.id,min:[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),corners[0]![2]]as V3,max:[Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1])),project(north([p.position[0],p.position[1],p.position[2]+d.height]))[2]]as V3}})
  obstacles.push({id:assemblyId,min:[position[0]-2,position[1]-2,-.3],max:[position[0]+q.length+2,position[1]+q.width+3,q.height]})
  for(let phase=0;phase<3;phase++){
   const fraction=.3+phase*.2,terminalId=`terminal/${member.role}/export-lv-${phase+1}`,terminal:V3=[position[0]+fraction*q.length-.7,position[1]+q.width+.4,q.height*.54-.9],end:V3=[terminal[0]+.7,terminal[1]+1.2,q.height*.54],start=project(generatorTip(phase))
   add(box(terminalId,`${member.label} export LV terminal box phase ${phase+1}`,'context',terminal,1.4,1.2,1.8,{material:'equipment'}),member.subjectId,'')
   const route=source.elements.find(e=>e.id===`conductor/${member.role}-phase-${phase+1}`)!;if(!route.path)throw Error('The existing switchyard export feeder has no retained path')
   route.path[route.path.length-1]=[position[0]+fraction*q.length,position[1]+.29*q.width,position[2]+.96*q.height]
   route.path[route.path.length-2]![1]=route.path.at(-1)![1]
   route.dependsOn=[bodyId]
   const lane=project([0,unitBounds.min[1]-q.serviceClearance-(phase-1)*.75,.4+phase*.75]),via:V3=[(start[0]+position[0])/2,lane[1],lane[2]],margin=q.serviceClearance+q.bendRadius,min:V3=[Math.min(start[0],position[0])-margin,Math.min(start[1],via[1],position[1])-margin,Math.min(0,start[2])-margin],max:V3=[Math.max(start[0],position[0]+q.length)+margin,Math.max(start[1],end[1])+margin+2*(q.lvDiameter+2*q.clearance+2*q.bendRadius),Math.max(start[2],q.height)+margin]
   const reservation=q.lvDiameter/2+q.clearance+q.bendRadius,guideFrom:V3=[start[0],obstacles.find(box=>box.id==='building/turbine-hall')!.min[1]-reservation-2*q.bendRadius,(start[2]+lane[2])/2],guideTo:V3=[end[0],position[1]+q.width+3+reservation+2*q.bendRadius+phase*(q.lvDiameter+2*q.clearance+2*q.bendRadius),(end[2]+lane[2])/2]
   const solved=routePhysicalConnection({id:`export-lv/${member.role}/${phase+1}`,from:{point:start,outward:[0,-1,0],obstacleId:'building/turbine-hall'},to:{point:end,outward:[0,1,0],obstacleId:assemblyId},obstacles,envelope:{min,max},radius:q.lvDiameter/2,clearance:q.clearance,bendRadius:q.bendRadius,via:[guideFrom,via,guideTo]})
   const path=roundedPhysicalRoute(solved.points,q.bendRadius,q.geometryTolerance).map(point=>[...point]as V3)
   add(box(`conductor/${member.role}/generator-export-${phase+1}`,`${member.label} generator to step-up transformer phase ${phase+1}`,'conductor',[0,0,0],1,q.lvDiameter,q.lvDiameter,{path,installation:'cable-corridor',terminatesBeyond:false,dependsOn:[terminalId,bodyId],layerId:'utility-routes'}),member.subjectId,'')
  }
  const phases=source.elements.filter(element=>element.id.startsWith(`conductor/${member.role}/generator-export-`))
  for(let a=0;a<phases.length;a++)for(let b=a+1;b<phases.length;b++)if(physicalRouteSeparation(phases[a]!.path!,phases[b]!.path!)<q.lvDiameter+2*q.clearance)throw Error(`Export phases violate their declared physical separation: ${phases[a]!.id}/${phases[b]!.id}`)
  const disposition=coverage.dispositions.find(d=>d.subjectId===member.subjectId)!;disposition.reason='One aggregate Grid unit-export subject is represented by a distinct campus-owned generator step-up transformer, its LV/HV terminations, generator phase corridors and switchyard export bay/feeders. This is not the separate 80 MW process-model unit auxiliary transformer. Ratings, protection, penetrations and installation engineering are not inferred.'
 }
 coverage.evidence.origin+=' Separate campus-owned generator step-up installations derive their generator phase terminals from the exact related unit physical model. Export phase routing is authored and clearance-checked against conservative building envelopes; the hall exit is an explicitly illustrative penetration, not a qualified design.'
}
