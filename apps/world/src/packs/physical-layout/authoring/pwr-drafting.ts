import {restorePwrFoundations} from './pwr-foundations.ts'
import {authorPwrRouting} from './pwr-routing.ts'
import {physicalCorrespondenceSchema} from '../model.ts'
import {physicalCoverageEvidenceSchema} from '../coverage.ts'
import arrangement from '../pwr-campus.arrangement.json'
import {localPointAtAnchor} from '../native/campus/author-campus.ts'
import unitSource from '../pwr-full-unit-architecture.source.json'
import unitBindings from '../pwr-full-unit-architecture.bindings.json'
import unitCoverage from '../pwr-full-unit-architecture.coverage.json'
import campusSource from '../pwr-campus-architecture.source.json'
import campusBindings from '../pwr-campus-architecture.bindings.json'
import campusCoverage from '../pwr-campus-architecture.coverage.json'
import { physicalSourceSchema, parameters, elementWorld, type V3 } from '../native/drafting/source.ts'

/** Explicit architectural drawing intent over the retained physical facts.
 * Coordinates are authored study assumptions; no OEM/access qualification. */
const createUnit=()=>{
 const source=physicalSourceSchema.parse({...structuredClone(unitSource),northAxis:'negative-y'})
 restorePwrFoundations(source)
 const areaView=source.viewAreas?.find(area=>area.id==='area/turbine-island')??source.viewAreas?.[0]
 if(areaView)areaView.levelInspectionViews=[{levelId:'operating',view:{bearing:142.75774,pitch:52.75774,target:[44,18,18]}},{levelId:'lower',view:{bearing:139.89295,pitch:49.89295,target:[44,25,5]}}]
 source.layers!.push({id:'plan-grid',label:'Structural grid',defaultVisible:true})
 source.layers!.find(layer=>layer.id==='plan-allowances')!.defaultVisible=true
 source.planIntent={dimensionUnit:'mm',floorJoints:source.elements.filter(e=>e.kind==='slab'&&e.id!=='hatch-cover').map(e=>({elementId:e.id,spacing:[5.5,6]})),grids:[{id:'turbine-hall',buildingId:'building/turbine-hall',spaceId:'space/turbine-hall',levelIds:['lower','operating'],bubbleOffset:2.7,dimensionOffset:1.4,overallOffset:5.4,axes:[...Array.from({length:9},(_,i)=>({id:`axis/${i+1}`,label:String(i+1),axis:'x' as const,elementId:`column/${i}/0.4`,fraction:.5})),{id:'axis/A',label:'A',axis:'y',elementId:'column/0/0.4',fraction:.5},{id:'axis/B',label:'B',axis:'y',elementId:'column/0/36.4',fraction:.5}]}],contexts:[{elementId:'stair/main',levelIds:['operating'],depiction:'projection'},{elementId:'building/feedwater-annex',levelIds:['operating'],depiction:'below'},...source.elements.filter(e=>e.kind==='equipment'&&e.equipmentKind==='lp').map(e=>({elementId:e.id,levelIds:['lower'],depiction:'above' as const})),...source.elements.filter(e=>e.id.startsWith('structure/runway/')||e.id.startsWith('structure/crane/bridge-')||e.id==='structure/crane/trolley').map(e=>({elementId:e.id,levelIds:['operating'],depiction:'above' as const}))],projectedOpenings:source.elements.filter(e=>e.kind==='opening'&&e.id.startsWith('opening/wall/hall-north/W-')).map(e=>({elementId:e.id,levelIds:['operating']})),strokes:[{elementId:'structure/shaftline',levelIds:['operating'],width:.3,material:'equipment-line'}],labelPositions:[{annotationId:'annotation/access-operating',anchor:[46,32.9]},{annotationId:'annotation/access-lower',anchor:[46,32.9]},{annotationId:'annotation/withdrawal',anchor:[77.7,24.6]},...['msr-1','msr-2','stop-valve','cp-a','cp-b','mfw-a','mfw-b'].map(id=>({annotationId:`annotation/label/${id}`,height:.65}))]}
 for(const e of source.elements)if(e.id.startsWith('structure/bearing/')&&e.id.endsWith('/base'))e.planSymbol='bearing'
 const swings:Record<string,number>={'D-W1a':-1,'D-W1b':1,'D-N1':1,'D-P1a':1,'D-P1b':-1,'D-P3a':-1,'D-P3b':1}
 for(const[name,sign]of Object.entries(swings)){const e=source.elements.find(e=>e.id===`door/${name}`);if(!e)throw Error(`Original access leaf missing: ${name}`);e.planDoorPose='open';e.door={swing:sign*Math.PI/2}}
 source.planIntent.strokes.push(...source.elements.filter(e=>e.member?.kind==='tube'&&e.layerId==='utility-routes').map(e=>({elementId:e.id,levelIds:[e.levelId],width:.13,material:e.material??'pipe'})))
 source.planIntent.sections=[{id:'A-A',label:'A–A',levelIds:['lower','operating'],scopeIds:[source.rootScope.id,'building/turbine-hall','space/turbine-hall'],anchor:[46.2,44.2],horizontalAxis:'x',elementIds:source.elements.filter(e=>e.equipmentKind==='lp'||e.equipmentKind==='condenser'||e.id.startsWith('pier/')).map(e=>e.id),floorIds:['lower','operating'],scale:.5}]
 // The structural grid supplies these clear/chained measurements once.
 source.planAnnotations=source.planAnnotations!.filter(a=>a.id!=='annotation/hatch-cover'&&!(a.kind==='dimension'&&a.measure.elementId==='space/turbine-hall'))
 const hatch=source.elements.find(e=>e.id==='hatch-cover')!;hatch.planSymbol='hatch';hatch.planTag='FLOOR HATCH'
 for(const[id,local]of[['msr-1',[3.7,-.8,0]],['msr-2',[3.7,4.8,0]],['stop-valve',[.9,-.9,0]]]as const){const label=source.planAnnotations.find(a=>a.id===`annotation/label/${id}`);if(label?.kind==='label')label.anchor.local=[...local]}
 for(const id of['cp-a','cp-b','mfw-a','mfw-b']){const element=source.elements.find(e=>e.id===id)!,d=parameters(source,element),label=source.planAnnotations.find(a=>a.id===`annotation/label/${id}`);if(label?.kind==='label')label.anchor.local=[d.length/2,d.width+1.25,d.height]}
 const room=source.planAnnotations.find(a=>a.id==='annotation/label/space/turbine-hall')!
 if(room.kind==='label'){room.text='TURBINE HALL';room.anchor.local=[44,2.5,0]}
 const annex=source.planAnnotations.find(a=>a.id==='annotation/label/space/feedwater-room')
 if(annex?.kind==='label'){annex.text='FEEDWATER PUMP ROOM';annex.anchor.local=[16,2,0]}
 const hall=source.elements.find(e=>e.id==='space/turbine-hall')!,d=parameters(source,hall)
 source.planAnnotations.push({id:'annotation/hall-area',kind:'label',role:'note',text:`${new Intl.NumberFormat('en').format(d.length*d.width)} m² floorplate · ${d.length} × ${d.width} m`,levelIds:['lower','operating'],scopeIds:['unit','building/turbine-hall','space/turbine-hall'],layerId:'plan-labels',anchor:{elementId:hall.id,local:[d.length/2,3.85,0]},rotation:0})
 const area=(id:string,label:string,role:'access'|'laydown',points:Array<[number,number]>,levelId:string,annex=false)=>{const z=source.levels.find(l=>l.id===levelId)!.elevation;source.planAnnotations!.push({id,kind:'hatch',role,label,basis:'illustrative',levelIds:[levelId],scopeIds:[source.rootScope.id,annex?'building/feedwater-annex':'building/turbine-hall',annex?'space/feedwater-room':'space/turbine-hall'],layerId:'plan-allowances',outline:points.map(([x,y])=>[x,y,z])})}
 area('annotation/access-operating','2 m ACCESS SPINE','access',[[9,31.3],[81.7,31.3],[81.7,23.7],[84.8,23.7],[84.8,33.3],[9,33.3],[9,31.3]],'operating')
 area('annotation/access-lower','ACCESS SPINE','access',[[9,31.3],[84.8,31.3],[84.8,33.3],[14.725,33.3],[14.725,39],[12.475,39],[12.475,33.3],[9,33.3],[9,31.3]],'lower')
 area('annotation/access-west','WEST ACCESS','access',[[1,24.2],[9,24.2],[9,26.2],[1,26.2],[1,24.2]],'lower')
 area('annotation/access-annex','PUMP ROOM ACCESS','access',[[12.475,39],[14.725,39],[14.725,44.5],[36.2,44.5],[36.2,46.5],[37.925,46.5],[37.925,53.2],[35.675,53.2],[35.675,46.5],[14.725,46.5],[14.725,52.2],[12.475,52.2],[12.475,39]],'lower',true)
 area('annotation/service-bay','SERVICE BAY · 8.5 × 4.2 m','laydown',[[31.2,39.7],[39.7,39.7],[39.7,43.9],[31.2,43.9],[31.2,39.7]],'lower',true)
 for(const[id,y,width]of[['working-north',43.4,.9],['working-south',46.8,1]]as const){area(`annotation/${id}`,'PUMP WORKING AISLE','access',[[15.5,y],[30.2,y],[30.2,y+width],[15.5,y+width],[15.5,y]],'lower',true);source.planIntent.labelPositions.push({annotationId:`annotation/${id}`,visible:false})}
 source.planIntent.labelPositions.push({annotationId:'annotation/access-annex',anchor:[23,45.5],height:.6},{annotationId:'annotation/access-west',visible:false})
 for(const annotation of source.planAnnotations)if(annotation.kind==='hatch'){if(annotation.id==='annotation/laydown')annotation.label='CASING / ROTOR LAYDOWN';if(annotation.id==='annotation/withdrawal')annotation.label='ROTOR WITHDRAWAL'}
 const bindings=physicalCorrespondenceSchema.array().parse(structuredClone(unitBindings)),coverage=physicalCoverageEvidenceSchema.parse(structuredClone(unitCoverage)),routing=authorPwrRouting(source,bindings,coverage)
 if(routing.attempts.some(attempt=>attempt.outcome==='unresolved'))throw Error(`PWR authoring has unresolved physical connections: ${routing.attempts.filter(attempt=>attempt.outcome==='unresolved').map(attempt=>attempt.id).join(', ')}`)
 return{source:physicalSourceSchema.parse(source),bindings,coverage}
}
// Only offline authoring retains this deterministic result. Every caller gets
// its own mutable draft; neither runtime compilation nor a live sample searches.
let unitArtifacts:ReturnType<typeof createUnit>|undefined
export const createPwrDraftingUnitArtifacts=()=>structuredClone(unitArtifacts??=createUnit())
export const createPwrDraftingCampusArtifacts=()=>{
 const source=physicalSourceSchema.parse({...structuredClone(campusSource),northAxis:'positive-y'}),unit=createPwrDraftingUnitArtifacts().source,transformer=unit.elements.find(e=>e.id==='equipment/unitAuxTransformer')!,d=parameters(unit,transformer),pose=elementWorld(unit,transformer)
 for(const member of arrangement.units)for(let phase=0;phase<3;phase++){
  // Same three authored bushing tips as the reusable transformer family,
  // transformed through the unit's declared frame and geographic placement.
  const x=(.3+phase*.2)*d.length,y=.29*d.width,z=.96*d.height,raw:V3=[pose.position[0]+Math.cos(pose.yaw)*x-Math.sin(pose.yaw)*y-unit.origin[0],pose.position[1]+Math.sin(pose.yaw)*x+Math.cos(pose.yaw)*y-unit.origin[1],pose.position[2]+z-unit.origin[2]],local:V3=[raw[0],unit.northAxis==='negative-y'?-raw[1]:raw[1],raw[2]],end=localPointAtAnchor(arrangement.siteAnchor as[number,number],member.anchor as[number,number],local),conductor=source.elements.find(e=>e.id===`conductor/${member.role}-phase-${phase+1}`)!
  conductor.path![conductor.path!.length-1]=end
  conductor.path![conductor.path!.length-2]![1]=end[1]
 }
 return{source:physicalSourceSchema.parse(source),bindings:structuredClone(campusBindings),coverage:structuredClone(campusCoverage)}
}
