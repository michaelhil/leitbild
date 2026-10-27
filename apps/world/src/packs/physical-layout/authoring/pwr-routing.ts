import {compileProcessPlant} from '../../process-plant/plant-compiler.ts'
import type {PhysicalCoverageEvidence} from '../coverage.ts'
import {parameters,elementWorld,type Source,type Element,type V3} from '../native/drafting/source.ts'
import {physicalTerminalCandidates,type PhysicalTerminalCandidate} from './terminal-placement.ts'
import {physicalRouteIntersects} from '../native/routing/route.ts'
import {compilePhysicalObjects} from '../native/drafting/compile-scene.ts'
import {solvePhysicalRoutingNetwork} from '../native/routing/compile.ts'
import type {PhysicalRouting,RoutingTerminal} from '../native/routing/source.ts'
import type {PackPhysicalScene} from '../../../core/packs/scene.ts'

type Binding={physicalElementId:string;elementId:string;relation:'represents'|'partOf'|'houses'}
/** Authored illustrative installation policy, not OEM/nozzle engineering data.
 * Actual graph diameter wins; absent cable/pipe dimensions are explicit source
 * assumptions, persisted per connection rather than a hidden renderer rule. */
export const pwrRoutingPolicy={fluidDiameter:.28,electricalDiameter:.12,clearance:.15,bendDiameterRatio:3,geometryTolerance:.01}
const distance=(a:readonly number[],b:readonly number[])=>Math.hypot(...a.map((v,i)=>v-b[i]!))
const center=(object:PackPhysicalScene['objects'][number]):V3=>object.bounds!.min.map((v,i)=>(v+object.bounds!.max[i]!)/2)as V3
const parsePort=(ref:string)=>{const at=ref.lastIndexOf('.');if(at<1)throw Error(`Invalid model port reference: ${ref}`);return{subjectId:ref.slice(0,at),port:ref.slice(at+1)}}

/** Build source constraints from the exact graph and accepted correspondences.
 * Failed placement/route attempts remain explicit owner coverage dispositions;
 * no runtime fallback, graph alias or empty manufactured tube is admitted. */
export const authorPwrRouting=(source:Source,bindings:Binding[],coverage:PhysicalCoverageEvidence)=>{
 const plant=compileProcessPlant({id:'authoring',model:{ref:coverage.modelRequirement.modelRef,parameters:{loopCount:4}},operatingPoint:{ref:'process-plant.pwr.full-power'},automation:{ref:'process-plant.pwr.standard'}})
 if(plant.modelDigest!==coverage.modelRequirement.modelDigest)throw Error('Routing authoring graph differs from the exact physical owner model')
 const graph=plant.sourceGraph,elements=new Map(source.elements.map(e=>[e.id,e]))
 // The retained study placed paired MFW/AFW valves side by side with their
 // nozzles pointing into one another. Preserve centres, orient the parallel
 // bank toward its actual steam-generator row, then solve from real nozzles.
 // This is an explicit installation revision, not a displaced route endpoint.
 const bound=(subject:string)=>bindings.map(b=>b.elementId===subject?elements.get(b.physicalElementId):undefined).find((e):e is Element=>e?.kind==='equipment')
 for(const loop of ['A','B','C','D']){
  const generator=bound(`sg${loop}`);if(!generator)throw Error(`Steam-generator valve bank has no physical peer: ${loop}`)
  const gp=elementWorld(source,generator),gd=parameters(source,generator),targetY=gp.position[1]+Math.sin(gp.yaw)*gd.length/2+Math.cos(gp.yaw)*gd.width/2
  for(const name of ['feedwaterControlValve','auxFeedwaterValve']){const e=bound(`${name}${loop}`);if(!e)throw Error(`Valve bank has no physical occurrence: ${name}${loop}`);const p=elementWorld(source,e),d=parameters(source,e),cx=p.position[0]+Math.cos(p.yaw)*d.length/2-Math.sin(p.yaw)*d.width/2,cy=p.position[1]+Math.sin(p.yaw)*d.length/2+Math.cos(p.yaw)*d.width/2,yaw=targetY>=cy?Math.PI/2:-Math.PI/2;e.pose={position:[cx-Math.cos(yaw)*d.length/2+Math.sin(yaw)*d.width/2,cy-Math.sin(yaw)*d.length/2-Math.cos(yaw)*d.width/2,p.position[2]],yaw}}
 }
 const objects=compilePhysicalObjects({source,bindings}),roster=new Map(objects.map(o=>[o.id,o]))
 const physical=new Map<string,Element[]>()
 for(const b of bindings){const e=elements.get(b.physicalElementId);if(!e||!roster.has(e.id)||e.disposition==='removed')continue;const list=physical.get(b.elementId)??[];if(!list.some(v=>v.id===e.id))list.push(e);physical.set(b.elementId,list)}
 const kinds=new Map(graph.components.map(c=>[c.id,c.kind])),componentIds=new Set(graph.components.map(c=>String(c.id)))
 if(graph.connections.some(c=>componentIds.has(String(c.id))))throw Error('Physical graph component and connection identities are ambiguous')
 const terminals=new Map<string,RoutingTerminal>(),neighbours=new Map<string,V3[]>(),portKinds=new Map<string,'pipe'|'electrical'>(),portMargins=new Map<string,number>(),terminalFailures=new Map<string,string>()
 const eligible=(subject:string,kind:'pipe'|'electrical')=>{
   let values=(physical.get(subject)??[]).filter(e=>['equipment','pipe','slab'].includes(e.kind))
   if(kind==='electrical'&&values.some(e=>e.equipmentKind==='generator'))values=values.filter(e=>e.equipmentKind==='generator')
   if(kind==='pipe'&&values.some(e=>e.kind==='equipment'&&!['generator','exciter'].includes(e.equipmentKind!)))values=values.filter(e=>!['generator','exciter'].includes(e.equipmentKind!))
   return values.sort((a,b)=>a.id.localeCompare(b.id))
 }
 for(const edge of graph.connections){if(!['fluidFlow','electricalPower'].includes(edge.connectionKind))continue;const kind=edge.connectionKind==='electricalPower'?'electrical':'pipe',a=parsePort(edge.from),b=parsePort(edge.to)
  for(const[from,to]of[[a,b],[b,a]]){const key=`${from!.subjectId}.${from!.port}`,points=neighbours.get(key)??[];for(const e of eligible(to!.subjectId,kind))points.push(center(roster.get(e.id)!));neighbours.set(key,points);portKinds.set(key,kind);const diameter=edge.physical?.diameterM??(kind==='pipe'?pwrRoutingPolicy.fluidDiameter:pwrRoutingPolicy.electricalDiameter);portMargins.set(key,Math.max(portMargins.get(key)??0,diameter/2+pwrRoutingPolicy.clearance+diameter*pwrRoutingPolicy.bendDiameterRatio))}
 }
 const obstacleElementIds=source.elements.filter(e=>e.disposition!=='removed'&&(e.kind==='equipment'||e.kind==='support'&&e.member?.kind==='i-section'&&e.member.axis==='z')).map(e=>e.id)
 const obstacleBoxes=obstacleElementIds.map(id=>({id,...roster.get(id)!.bounds!}))
 const clearExit=(candidate:PhysicalTerminalCandidate,bodyId:string,margin:number)=>{
  const boxes=obstacleBoxes.map(box=>({id:box.id,min:box.min.map(v=>v-margin)as V3,max:box.max.map(v=>v+margin)as V3})),own=boxes.find(box=>box.id===bodyId)
  let length=margin,face:{axis:number;coordinate:number;distance:number}|undefined
  if(own&&candidate.point.every((v,i)=>v>=own.min[i]!&&v<=own.max[i]!)){const choices=candidate.direction.flatMap((v,axis)=>v?[{axis,coordinate:(v>0?own.max:own.min)[axis]!,distance:((v>0?own.max:own.min)[axis]!-candidate.point[axis]!)/v}]:[]);face=choices.reduce((a,b)=>a.distance<=b.distance?a:b);length=Math.max(length,face.distance)}
  const end=candidate.point.map((v,i)=>v+candidate.direction[i]!*length)as V3;if(face&&length===face.distance)end[face.axis]=face.coordinate
  return !boxes.some(box=>box.id!==bodyId&&physicalRouteIntersects(candidate.point,end,box))
 }
 const terminal=(ref:string):RoutingTerminal|undefined=>{
  if(terminals.has(ref))return terminals.get(ref)
  const endpoint=parsePort(ref),kind=portKinds.get(ref)!,bodies=eligible(endpoint.subjectId,kind),others=neighbours.get(ref)??[]
  if(!bodies.length||!others.length){terminalFailures.set(ref,'No physical endpoint body or placed peer is declared.');return undefined}
  const average:V3=[0,1,2].map(axis=>others.reduce((sum,p)=>sum+p[axis]!,0)/others.length)as V3
  const alignment=(value:PhysicalTerminalCandidate)=>value.direction.reduce((sum,v,axis)=>sum+v*(average[axis]!-value.point[axis]!),0)
  const candidates=bodies.flatMap(e=>physicalTerminalCandidates(source,e,roster.get(e.id)!,endpoint.port,kind,average).map(candidate=>({e,candidate}))).sort((a,b)=>distance(a.candidate.point,average)-distance(b.candidate.point,average)||alignment(b.candidate)-alignment(a.candidate)||a.e.id.localeCompare(b.e.id))
  const chosen=candidates.find(value=>clearExit(value.candidate,value.e.id,portMargins.get(ref)!))
  if(!chosen){terminalFailures.set(ref,'No clearance-safe authored nozzle is available on the declared family/body surfaces.');return undefined}
  const {e,candidate}=chosen,value:RoutingTerminal={id:`port/${ref}`,elementId:e.id,subjectId:endpoint.subjectId,port:endpoint.port,local:candidate.local,outward:candidate.outward};terminals.set(ref,value);return value
 }
 const network:PhysicalRouting={geometryTolerance:pwrRoutingPolicy.geometryTolerance,terminals:[],connections:[],obstacleElementIds},attempts:Array<{id:string;outcome:string;reason?:string;constraint?:PhysicalRouting['connections'][number];terminals?:RoutingTerminal[]}>=[]
 const reasonFor=(subject:string)=>coverage.dispositions.find(d=>d.subjectId===subject)?.reason??'No physical representation is declared for this graph endpoint.'
 for(const edge of graph.connections){
  const a=parsePort(edge.from),b=parsePort(edge.to),id=String(edge.id)
  const classify=(disposition:'functional'|'boundary'|'internal'|'unresolved',reason:string)=>{coverage.dispositions.push({subjectId:id,disposition,reason,physicalElementIds:[]});attempts.push({id,outcome:disposition,reason})}
  if(edge.connectionKind==='thermalContact'){classify('functional','Thermal exchange inside the reactor assembly is not a pipe or electrical span.');continue}
  if(!['fluidFlow','electricalPower'].includes(edge.connectionKind)){classify('functional','This graph relationship has no supported physical pipe or electrical installation meaning.');continue}
  if(kinds.get(a.subjectId as never)==='containmentVolume'||kinds.get(b.subjectId as never)==='containmentVolume'){classify('functional','This graph exchange terminates in the modelled containment medium; no separate conduit/nozzle hardware is authored.');continue}
  const from=terminal(edge.from),to=terminal(edge.to)
  if(!from||!to){const boundary=[a.subjectId,b.subjectId].some(s=>coverage.dispositions.find(d=>d.subjectId===s)?.disposition==='boundary');classify(boundary?'boundary':'unresolved',`Exact graph endpoint is outside the placed installation: ${!from?edge.from:edge.to}. ${terminalFailures.get(!from?edge.from:edge.to)??reasonFor(!from?a.subjectId:b.subjectId)}`);continue}
  if(from.elementId===to.elementId){classify('internal','Both graph ports are housed in the same physical assembly; no external conduit span is fabricated.');continue}
  const kind=edge.connectionKind==='electricalPower'?'electrical':'pipe',diameter=edge.physical?.diameterM??(kind==='pipe'?pwrRoutingPolicy.fluidDiameter:pwrRoutingPolicy.electricalDiameter),bendRadius=diameter*pwrRoutingPolicy.bendDiameterRatio,margin=diameter+bendRadius+pwrRoutingPolicy.clearance
  const owners=[roster.get(from.elementId)!,roster.get(to.elementId)!],min:V3=[0,1,2].map(axis=>Math.min(...owners.map(o=>o.bounds!.min[axis]!+source.origin[axis]!))-margin)as V3,max:V3=[0,1,2].map(axis=>Math.max(...owners.map(o=>o.bounds!.max[axis]!+source.origin[axis]!))+margin)as V3
  const connection:PhysicalRouting['connections'][number]={id:`connection/${id}`,graphConnectionId:id,from:from.id,to:to.id,kind,diameter,clearance:pwrRoutingPolicy.clearance,bendRadius,envelope:{min,max},material:kind==='electrical'?'crane':edge.nominalFluid==='steam'?'steam':'pipe',layerId:'utility-routes'}
  try{
    const candidate={...source,routing:{...network,terminals:[...terminals.values()],connections:[connection]}}
    const solved=solvePhysicalRoutingNetwork(candidate,objects)!.connections[0]!
    network.connections.push(solved);bindings.push({physicalElementId:solved.id,elementId:id,relation:'represents'});coverage.dispositions.push({subjectId:id,disposition:'direct',reason:'Illustrative graph-exact installation. Port placement, clearance and missing diameters are authored assumptions; the accepted 3D route is validated against the declared equipment/column obstacle set. Civil penetrations and maintenance qualification are not asserted.',physicalElementIds:[solved.id]});attempts.push({id,outcome:'routed'})
  }catch(error){classify('unresolved',`No accepted route in the authored envelope: ${error instanceof Error?error.message:String(error)}. The connection remains in exact owner coverage; no fallback path is drawn.`);Object.assign(attempts.at(-1)!,{constraint:connection,terminals:[from,to]})}
 }
 const used=new Set(network.connections.flatMap(c=>[c.from,c.to]));network.terminals=[...terminals.values()].filter(t=>used.has(t.id));source.routing=network
 coverage.evidence.origin+=' Exact graph connection coverage and accepted authoring-time route solutions are included. Geometry is illustrative and does not qualify wall/floor penetrations.'
 return{components:graph.components.length,connections:graph.connections.length,routed:network.connections.length,attempts,terminalPlacementFailures:Object.fromEntries(terminalFailures)}
}
