import {createHash} from 'node:crypto'
import unitSource from '../pwr-full-unit-connected.source.json'
import unitBindings from '../pwr-full-unit-connected.bindings.json'
import unitCoverage from '../pwr-full-unit-connected.coverage.json'
import campusSource from '../pwr-campus-connected.source.json'
import campusBindings from '../pwr-campus-connected.bindings.json'
import campusCoverage from '../pwr-campus-connected.coverage.json'
import {canonicalPhysicalJson,physicalCorrespondenceSchema} from '../model.ts'
import {physicalCoverageEvidenceSchema} from '../coverage.ts'
import {physicalSourceSchema,physicalSourceFacts,elementWorld,parameters,type Element,type V3} from '../native/drafting/source.ts'
import {compilePhysicalObjects,compilePhysicalScene,physicalObjectsBounds} from '../native/drafting/compile-scene.ts'
import {solvePhysicalRoutingNetwork} from '../native/routing/compile.ts'
import {physicalSceneShapeFacts} from '../source-validation.ts'
import {authorPwrCampusCirculation} from './pwr-circulation.ts'

type Axis=[-1|0|1,-1|0|1,-1|0|1]
interface Tap {readonly port:string;readonly at:number;readonly outward:Axis}
interface Installation {
 readonly subject:string;readonly elementId:string;readonly axis:'x'|'y';readonly from:V3;readonly to:V3
 readonly material:'steam'|'pipe';readonly nozzleReach:number;readonly flangeThickness:number;readonly flangeRadius:number
 readonly capThickness:number;readonly capRadius:number;readonly taps:readonly Tap[]
}
/** Illustrative installation dimensions in metres, deliberately authored rather
 * than selected by nearest-body geometry. These are not OEM nozzle schedules.
 * Each straight manifold has separate side nozzles and two blind end plates;
 * every external turn belongs to an exact graph connection. */
export const pwrManifoldInstallations:readonly Installation[]=[
 {subject:'mainSteamHeader',elementId:'route/main-steam-header',axis:'y',from:[-8,-18,18.5],to:[-8,27,18.5],material:'steam',nozzleReach:.95,flangeThickness:.12,flangeRadius:.25,capThickness:.16,capRadius:.56,taps:[
  {port:'inletA',at:-17.3,outward:[-1,0,0]},{port:'inletB',at:-3.3,outward:[-1,0,0]},{port:'inletC',at:10.7,outward:[-1,0,0]},{port:'inletD',at:24.7,outward:[-1,0,0]},
  {port:'outletA',at:16.45,outward:[1,0,0]},{port:'outletC',at:9.9,outward:[1,0,0]}]},
 {subject:'feedwaterHeader',elementId:'route/feedwater-header',axis:'y',from:[-2,-18,1.65],to:[-2,40,1.65],material:'pipe',nozzleReach:.7,flangeThickness:.1,flangeRadius:.23,capThickness:.12,capRadius:.3,taps:[
  {port:'inletA',at:34,outward:[1,0,0]},{port:'inletB',at:38,outward:[1,0,0]},
  {port:'outletA',at:-17.3,outward:[-1,0,0]},{port:'outletB',at:-3.3,outward:[-1,0,0]},{port:'outletC',at:10.7,outward:[-1,0,0]},{port:'outletD',at:24.7,outward:[-1,0,0]}]},
 {subject:'auxFeedwaterHeader',elementId:'route/aux-feedwater-header',axis:'x',from:[-84,58,9.2],to:[-36,58,9.2],material:'pipe',nozzleReach:.65,flangeThickness:.1,flangeRadius:.23,capThickness:.12,capRadius:.25,taps:[
  {port:'inletA',at:-82,outward:[0,-1,0]},{port:'inletB',at:-80,outward:[0,1,0]},{port:'inletC',at:-38,outward:[0,-1,0]},
  {port:'outletA',at:-52,outward:[0,-1,0]},{port:'outletB',at:-49,outward:[0,-1,0]},{port:'outletC',at:-46,outward:[0,-1,0]},{port:'outletD',at:-43,outward:[0,-1,0]}]},
 {subject:'safetyInjectionHeader',elementId:'route/safety-injection-header',axis:'x',from:[-66,60,3.8],to:[-16,60,3.8],material:'pipe',nozzleReach:.65,flangeThickness:.1,flangeRadius:.23,capThickness:.12,capRadius:.25,taps:[
  {port:'inletA',at:-64,outward:[0,-1,0]},{port:'inletB',at:-18,outward:[0,-1,0]},
  {port:'outletA',at:-55,outward:[0,-1,0]},{port:'outletB',at:-46,outward:[0,-1,0]},{port:'outletC',at:-37,outward:[0,-1,0]},{port:'outletD',at:-28,outward:[0,-1,0]}]},
 {subject:'containmentSprayHeader',elementId:'route/containment-spray-header',axis:'x',from:[-86,79,3.8],to:[-35.5,79,3.8],material:'pipe',nozzleReach:.65,flangeThickness:.1,flangeRadius:.23,capThickness:.12,capRadius:.25,taps:[
  {port:'inletA',at:-84,outward:[0,-1,0]},{port:'inletB',at:-37.5,outward:[0,-1,0]}]},
 {subject:'rhrHeader',elementId:'route/rhr-header',axis:'x',from:[-86,57,3.8],to:[-35.5,57,3.8],material:'pipe',nozzleReach:.65,flangeThickness:.1,flangeRadius:.23,capThickness:.12,capRadius:.28,taps:[
  {port:'inletA',at:-84,outward:[0,-1,0]},{port:'inletB',at:-37.5,outward:[0,-1,0]},{port:'outletA',at:-52,outward:[0,-1,0]}]},
 {subject:'pressurizerReliefHeader',elementId:'route/pressurizer-relief-header',axis:'x',from:[-55,23,13],to:[-48,23,13],material:'steam',nozzleReach:.65,flangeThickness:.1,flangeRadius:.23,capThickness:.12,capRadius:.25,taps:[
  {port:'inletA',at:-50,outward:[0,0,-1]},{port:'outletA',at:-53,outward:[0,0,-1]}]},
]
const hash=(value:unknown)=>createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const point=(base:V3,direction:Axis,distance:number):V3=>base.map((v,axis)=>v+direction[axis]!*distance)as V3
interface TurbinePhysicalFitting {readonly id:string;readonly kind:'msr-feed'|'lp-receiver';readonly equipmentId:string;readonly headerId:string;readonly mountAxis:Axis}
export const pwrTurbinePhysicalFittings:readonly TurbinePhysicalFitting[]=[
 {id:'route/turbine-msr-feed-1',kind:'msr-feed',equipmentId:'msr-1',headerId:'route/turbine-reheat-10.4',mountAxis:[0,1,0]},
 {id:'route/turbine-msr-feed-2',kind:'msr-feed',equipmentId:'msr-2',headerId:'route/turbine-reheat-26.6',mountAxis:[0,-1,0]},
 ...[24.5,35.5,46.5].flatMap((x,index)=>[10.4,26.6].map((y):TurbinePhysicalFitting=>({id:`route/turbine-receiver-${x}-${y}`,kind:'lp-receiver',equipmentId:`tg-lp-${index+1}`,headerId:`route/turbine-admission-${x}-${y}`,mountAxis:[0,y<18.4?-1:1,0]}))),
]

export const createPwrManifoldUnitInstallation=()=>{
 const source=physicalSourceSchema.parse(structuredClone(unitSource)),bindings=physicalCorrespondenceSchema.array().parse(structuredClone(unitBindings)),coverage=physicalCoverageEvidenceSchema.parse(structuredClone(unitCoverage))
 if(!source.routing||!source.planIntent)throw Error('Manifold authoring needs the exact accepted routing and drafting source')
 const changed=new Set<string>()
 for(const installation of pwrManifoldInstallations){
  const e=source.elements.find(e=>e.id===installation.elementId),disposition=coverage.dispositions.find(d=>d.subjectId===installation.subject)
  if(!e||e.kind!=='pipe'||e.disposition!=='installed'||!disposition||e.pose.yaw!==0||e.pose.position.some(v=>v!==0))throw Error(`Unexpected retained manifold authority: ${installation.subject}`)
  const axis=installation.axis==='x'?0:1,terminals=source.routing.terminals.filter(t=>t.elementId===e.id)
  if(terminals.length!==installation.taps.length||terminals.some(t=>t.subjectId!==installation.subject||!installation.taps.some(tap=>tap.port===t.port)))throw Error(`Authored manifold ports differ from the exact accepted graph: ${installation.subject}`)
  e.path=[structuredClone(installation.from),structuredClone(installation.to)];e.material=installation.material
  const hardware=(id:string,label:string,a:V3,b:V3,radius:number):Element=>{
   const position=a.map((v,i)=>Math.min(v,b[i]!))as V3,delta=b.map((v,i)=>v-a[i]!)as V3
   const body:Element={id,label,kind:'support',levelId:e.levelId,disposition:'installed',pose:{position,yaw:0},dimensions:{length:Math.max(Math.abs(delta[0]),radius*2),width:Math.max(Math.abs(delta[1]),radius*2),height:Math.max(Math.abs(delta[2]),radius*2)},member:{kind:'tube',points:[a.map((v,i)=>v-position[i]!)as V3,b.map((v,i)=>v-position[i]!)as V3],radius},material:installation.material,layerId:e.layerId,planDisplay:'projection',...(e.buildingId?{buildingId:e.buildingId}:{}),...(e.spaceIds?{spaceIds:e.spaceIds}:{})}
   source.elements.push(body);bindings.push({physicalElementId:id,elementId:installation.subject,relation:'partOf'});disposition.physicalElementIds.push(id)
   source.planIntent!.strokes.push({elementId:id,levelIds:[e.levelId],width:radius*2,material:installation.material})
   return body
  }
  const direction:Axis=axis===0?[1,0,0]:[0,1,0]
  for(const [end,position]of[['first',installation.from],['last',installation.to]]as const)hardware(`${e.id}/blind-${end}`,'Authored blind manifold end plate; closed, not a route continuation',point(position,direction,-installation.capThickness/2),point(position,direction,installation.capThickness/2),installation.capRadius)
  for(const tap of installation.taps){
   if(tap.outward[axis]!==0||tap.at<=installation.from[axis]||tap.at>=installation.to[axis])throw Error(`A manifold needs a strictly interior side tap: ${installation.subject}.${tap.port}`)
   const center=[...installation.from]as V3;center[axis]=tap.at
   const terminal=terminals.find(t=>t.port===tap.port)!,connectionDiameters=source.routing.connections.filter(c=>c.from===terminal.id||c.to===terminal.id).map(c=>c.diameter),radius=Math.max(...connectionDiameters)/2
   if(!connectionDiameters.length||radius>=(e.dimensions!.width!)/2||installation.flangeRadius<=radius)throw Error(`Invalid authored manifold nozzle dimensions: ${terminal.id}`)
   const end=point(center,tap.outward,installation.nozzleReach),nozzle=hardware(`${e.id}/nozzle/${tap.port}`,`Authored ${installation.subject}.${tap.port} side nozzle`,center,end,radius)
   hardware(`${e.id}/flange/${tap.port}`,`Authored ${installation.subject}.${tap.port} terminal flange`,point(end,tap.outward,-installation.flangeThickness),end,installation.flangeRadius)
   terminal.elementId=nozzle.id;terminal.local=end.map((v,i)=>v-nozzle.pose.position[i]!)as V3;terminal.outward=[...tap.outward];changed.add(terminal.id)
  }
  disposition.reason+=' R6 replaces unsupported compound illustrative tails with a straight authored manifold, separate graph-port nozzles and visible blind end plates. Dimensions/locations are illustrative installation assumptions; capped hardware ends are distinct from selected-view continuations. Only accepted external graph ports are spatially installed; functional/internal graph exchanges retain their existing explicit dispositions.'
 }
 // Restore physical interfaces omitted by the browser study, without inventing
 // process-model ports or changing its eight accepted reheat/admission paths.
 const turbine=coverage.dispositions.find(d=>d.subjectId==='turbine')!
 for(const fitting of pwrTurbinePhysicalFittings){
  const equipment=source.elements.find(e=>e.id===fitting.equipmentId)!,existing=source.elements.find(e=>e.id===fitting.headerId)!,d=parameters(source,equipment),pose=elementWorld(source,equipment)
  if(pose.yaw!==0||!existing.path||equipment.kind!=='equipment')throw Error(`Unexpected retained turbine family authority: ${fitting.equipmentId}`)
  let mount:V3,path:V3[],diameter:number
  if(fitting.kind==='msr-feed'){
   const positive=fitting.mountAxis[1]>0,local:V3=[(positive?1.8:7.4-1.9)*d.length/7.4,(positive?3+.5:-.5)*d.width/3,2.6*d.height/4.5]
   mount=local.map((v,i)=>v+pose.position[i]!)as V3
   const end=existing.path[0]!,offset:V3=[mount[0],end[1],mount[2]],rise:V3=[mount[0],end[1],end[2]]
   path=[mount,offset,rise,...(rise.every((v,i)=>v===end[i])?[]:[[...end]as V3])];diameter=positive ? .5 : .6
  }else{
   // The real retained LP family has a forty-sided central casing stripe.
   // +/-pi/4 are explicit ring vertices, not an envelope approximation.
   const sign=fitting.mountAxis[1],angle=sign*Math.PI/4,local:V3=[d.length/2,(11.2/2+Math.sin(angle)*5.12)*d.width/11.2,(2.2+Math.cos(angle)*2.06)*d.height/6.7]
   mount=local.map((v,i)=>v+pose.position[i]!)as V3
   const end=existing.path.at(-1)!
   path=[mount,[end[0],end[1],mount[2]],[...end]as V3];diameter=existing.dimensions!.width!
  }
  source.elements.push({id:fitting.id,label:fitting.kind==='msr-feed'?'Authored MSR nozzle to turbine reheat distribution':'Authored LP casing receiver to retained admission pipe',kind:'pipe',levelId:'operating',pose:{position:[0,0,0],yaw:0},dimensions:{length:1,width:diameter,height:diameter},path,material:'steam',layerId:'utility-routes',buildingId:equipment.buildingId,spaceIds:equipment.spaceIds,disposition:'installed'})
  bindings.push({physicalElementId:fitting.id,elementId:'turbine',relation:'partOf'});turbine.physicalElementIds.push(fitting.id)
 }
 turbine.reason+=' R6 adds two physical MSR-family nozzle feeds and six LP-casing receiver fittings to close inherited illustrative subassembly gaps. Existing reheat/admission paths and all turbine machinery are retained. These physical interfaces belong to the same lumped turbine and declare no independent internal graph port, flow direction or telemetry.'
 return{source,bindings,coverage,changed}
}

export const createPwrManifoldUnitArtifacts=()=>{
 const{source,bindings,coverage,changed}=createPwrManifoldUnitInstallation()
 const network=source.routing!,objects=compilePhysicalObjects({source,bindings}),terminals=new Map(network.terminals.map(t=>[t.id,t])),elements=new Map(source.elements.map(e=>[e.id,e]))
 const connections=network.connections.filter(c=>changed.has(c.from)||changed.has(c.to)).map(connection=>{
  const margin=connection.diameter+connection.bendRadius+connection.clearance,min=[...connection.envelope.min]as V3,max=[...connection.envelope.max]as V3
  for(const id of[connection.from,connection.to]){const t=terminals.get(id)!,pose=elementWorld(source,elements.get(t.elementId)!),c=Math.cos(pose.yaw),s=Math.sin(pose.yaw),p:V3=[pose.position[0]+c*t.local[0]-s*t.local[1],pose.position[1]+s*t.local[0]+c*t.local[1],pose.position[2]+t.local[2]];for(const a of[0,1,2]as const){min[a]=Math.min(min[a],p[a]-margin);max[a]=Math.max(max[a],p[a]+margin)}}
  return{...connection,envelope:{min,max}}
 })
 const solved=solvePhysicalRoutingNetwork({...source,routing:{...network,connections}},objects)!,byId=new Map(solved.connections.map(c=>[c.id,c]))
 network.connections=network.connections.map(c=>byId.get(c.id)??c)
 source.evidence.origin='Illustrative R6 manifold installation authored 28 October 2026 from the retained R5 connected PWR source and original browser architectural study. Seven compound header illustrations are replaced by explicit straight manifolds, separate graph-port side nozzles, terminal flanges and visible blind end plates. All external turns remain accepted graph connections; no free end is joined to nearby equipment by proximity. Unaffected accepted routes and all machinery/architecture are retained. Installation sizes and locations are authored assumptions, not OEM, as-built or safety qualification.'
 coverage.evidence.origin+=' R6 manifold installation is an illustrative authored revision, not OEM or as-built certification. Every manifold hardware end is either an exact graph-port nozzle or an explicitly closed blind end.'
 return{source:physicalSourceSchema.parse(source),bindings,coverage:physicalCoverageEvidenceSchema.parse(coverage)}
}

export const createPwrManifoldCampusArtifacts=()=>{
 const source=physicalSourceSchema.parse(structuredClone(campusSource)),bindings=physicalCorrespondenceSchema.array().parse(structuredClone(campusBindings)),coverage=physicalCoverageEvidenceSchema.parse(structuredClone(campusCoverage)),unit=createPwrManifoldUnitArtifacts()
 // The complete retained compiler includes routes and north-axis conversion.
 // These explicitly authoring-only id/owner/bounds fields are unused by its
 // objects-only witness: never Run identities or geometry/clipping limits.
 // A future intrinsic-shape port can remove this instance context without
 // duplicating the frozen native pipeline or dropping its accepted routes.
 const scene=compilePhysicalScene('authoring-dependency',{...unit,design:{digest:'authoring'},owner:{objectId:'authoring'},placement:{anchor:[0,0],bearing:0},bounds:{min:[-1e9,-1e9,-1e9],max:[1e9,1e9,1e9]}})
 const campus=compilePhysicalScene('authoring-campus',{source,bindings,design:{digest:'authoring'},owner:{objectId:'authoring'},placement:{anchor:[0,0],bearing:0},bounds:physicalObjectsBounds(compilePhysicalObjects({source,bindings}))})
 authorPwrCampusCirculation(source,scene,campus)
 const physicalSourceDigest=hash(physicalSourceFacts(unit.source)),physicalShapeDigest=hash(physicalSceneShapeFacts(scene.objects))
 if(!source.sourceDependencies?.length)throw Error('Manifold revision needs retained campus/unit dependencies')
 source.sourceDependencies=source.sourceDependencies.map(w=>{if(w.sourceId!==unit.source.id)throw Error(`Unexpected campus source dependency: ${w.sourceId}`);return{...w,physicalSourceDigest,physicalShapeDigest}})
 source.evidence.origin='Illustrative campus circulation revision authored 29 October 2026 from the retained R6 manifold installation. The common inter-unit road uses orthogonal service approaches and joined tangent pavement, checked against actual canonical east/north/up building and represented unit-equipment footprints. Related unit geometry, graph bindings and coverage are retained. Vehicle and campus electrical-clearance qualification is not established. This is an architectural study, not OEM, as-built or safety qualification.'
 return{source:physicalSourceSchema.parse(source),bindings,coverage}
}
