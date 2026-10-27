import {restorePwrFoundations} from './pwr-foundations.ts'
import unitSource from '../pwr-full-unit-architecture.source.json'
import unitBindings from '../pwr-full-unit-architecture.bindings.json'
import unitCoverage from '../pwr-full-unit-architecture.coverage.json'
import campusSource from '../pwr-campus-architecture.source.json'
import campusBindings from '../pwr-campus-architecture.bindings.json'
import campusCoverage from '../pwr-campus-architecture.coverage.json'
import { physicalSourceSchema, parameters, type Source } from '../native/drafting/source.ts'

/** Explicit architectural drawing intent over the retained physical facts.
 * Coordinates are authored study assumptions; no OEM/access qualification. */
export const createPwrDraftingUnitArtifacts=()=>{
 const source=physicalSourceSchema.parse({...structuredClone(unitSource),northAxis:'negative-y'})
 restorePwrFoundations(source)
 source.layers!.push({id:'plan-grid',label:'Structural grid',defaultVisible:true})
 source.layers!.find(layer=>layer.id==='plan-allowances')!.defaultVisible=true
 source.planIntent={dimensionUnit:'mm',floorJoints:source.elements.filter(e=>e.kind==='slab'&&e.id!=='hatch-cover').map(e=>({elementId:e.id,spacing:[5.5,6]})),grids:[{id:'turbine-hall',buildingId:'building/turbine-hall',spaceId:'space/turbine-hall',levelIds:['lower','operating'],bubbleOffset:2.7,dimensionOffset:1.4,overallOffset:5.4,axes:[...Array.from({length:9},(_,i)=>({id:`axis/${i+1}`,label:String(i+1),axis:'x' as const,elementId:`column/${i}/0.4`,fraction:.5})),{id:'axis/A',label:'A',axis:'y',elementId:'column/0/0.4',fraction:.5},{id:'axis/B',label:'B',axis:'y',elementId:'column/0/36.4',fraction:.5}]}],contexts:[{elementId:'stair/main',levelIds:['operating'],depiction:'projection'},{elementId:'building/feedwater-annex',levelIds:['operating'],depiction:'below'},...source.elements.filter(e=>e.kind==='equipment'&&e.equipmentKind==='lp').map(e=>({elementId:e.id,levelIds:['lower'],depiction:'above' as const})),...source.elements.filter(e=>e.id.startsWith('structure/runway/')||e.id.startsWith('structure/crane/bridge-')||e.id==='structure/crane/trolley').map(e=>({elementId:e.id,levelIds:['operating'],depiction:'above' as const}))],projectedOpenings:source.elements.filter(e=>e.kind==='opening'&&e.id.startsWith('opening/wall/hall-north/W-')).map(e=>({elementId:e.id,levelIds:['operating']})),strokes:[{elementId:'structure/shaftline',levelIds:['operating'],width:.3,material:'equipment-line'}],labelPositions:[{annotationId:'annotation/access-operating',anchor:[46,32.9]},{annotationId:'annotation/access-lower',anchor:[46,32.9]},{annotationId:'annotation/withdrawal',anchor:[77.7,24.6]},...['msr-1','msr-2','stop-valve','cp-a','cp-b','mfw-a','mfw-b'].map(id=>({annotationId:`annotation/label/${id}`,height:.65}))]}
 for(const e of source.elements)if(e.id.startsWith('structure/bearing/')&&e.id.endsWith('/base'))e.planSymbol='bearing'
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
 const area=(id:string,label:string,role:'access'|'laydown',points:Array<[number,number]>,levelId:string)=>{const z=source.levels.find(l=>l.id===levelId)!.elevation;source.planAnnotations!.push({id,kind:'hatch',role,label,basis:'illustrative',levelIds:[levelId],scopeIds:[source.rootScope.id,'building/turbine-hall','space/turbine-hall'],layerId:'plan-allowances',outline:points.map(([x,y])=>[x,y,z])})}
 area('annotation/access-operating','2 m ACCESS SPINE','access',[[9,31.3],[81.7,31.3],[81.7,23.7],[84.8,23.7],[84.8,33.3],[9,33.3],[9,31.3]],'operating')
 area('annotation/access-lower','ACCESS SPINE','access',[[9,31.3],[84.8,31.3],[84.8,33.3],[14.725,33.3],[14.725,39],[12.475,39],[12.475,33.3],[9,33.3],[9,31.3]],'lower')
 area('annotation/service-bay','SERVICE BAY · 8.5 × 4.2 m','laydown',[[31.2,39.7],[39.7,39.7],[39.7,43.9],[31.2,43.9],[31.2,39.7]],'lower')
 for(const annotation of source.planAnnotations)if(annotation.kind==='hatch'){if(annotation.id==='annotation/laydown')annotation.label='CASING / ROTOR LAYDOWN';if(annotation.id==='annotation/withdrawal')annotation.label='ROTOR WITHDRAWAL'}
 return{source:physicalSourceSchema.parse(source),bindings:structuredClone(unitBindings),coverage:structuredClone(unitCoverage)}
}
export const createPwrDraftingCampusArtifacts=()=>({source:physicalSourceSchema.parse({...structuredClone(campusSource),northAxis:'positive-y'}),bindings:structuredClone(campusBindings),coverage:structuredClone(campusCoverage)})
