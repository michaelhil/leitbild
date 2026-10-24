import * as W from 'web-ifc';
import {body,parameters,guid,local,world,hash,validate,envelopes,interfaces,rotate,type V3,type Model,type Element,type PhysicalType,type Params,type Mesh} from './model.ts';

const S=W.IFC4X3 as unknown as Record<string,any>;
const scalar=(name:string,value:unknown)=>new S[name](value);
const label=(v:string)=>scalar('IfcLabel',v),text=(v:string)=>scalar('IfcText',v),num=(v:number)=>scalar('IfcLengthMeasure',v),real=(v:number)=>scalar('IfcReal',v);
const en=(name:string,v:string)=>S[name][v];
export const SCHEMA='IFC4X3_ADD2';
// One native WASM owner per offline worker. Closing Models releases their data;
// repeated API initialization would retain a separate WASM heap per operation.
let workerApi:Promise<W.IfcAPI>|undefined;
export function api(){return workerApi??=(async()=>{const instance=new W.IfcAPI();await instance.Init();return instance;})();}
const settings={ALLOW_INCOMPATIBLE_SCHEMA_ALIASES:false,COORDINATE_TO_ORIGIN:false,CIRCLE_SEGMENTS:48,MEMORY_LIMIT:512*1024*1024};
export function write(api:W.IfcAPI,m:Model):Uint8Array{
 validate(m);const model=api.CreateModel({schema:SCHEMA,name:m.id,description:['Bounded illustrative authoring trial'],authors:['Leitbild'],organizations:['Leitbild'],authorization:'Offline experiment'},settings);
 const put=(kind:string,...args:unknown[])=>{const x=new S[kind](...args);api.WriteLine(model,x);return x;};
 const xyz=(p:V3)=>put('IfcCartesianPoint',p.map(num)),dir=(p:V3)=>put('IfcDirection',p.map(real));
 const axis=(p:V3=[0,0,0],yaw=0)=>put('IfcAxis2Placement3D',xyz(p),dir([0,0,1]),dir([Math.cos(yaw),Math.sin(yaw),0]));
 const place=(parent:any,p:V3=[0,0,0],yaw=0)=>put('IfcLocalPlacement',parent,axis(p,yaw));
 const root=(id:string,name=id)=>[scalar('IfcGloballyUniqueId',guid(m.id+'/'+id)),null,label(name),text('Illustrative authored geometry, not as-built')];
 const pset=(id:string,values:Record<string,string|number>)=>put('IfcPropertySet',...root(id+'/properties','LeitbildAuthoring'),Object.entries(values).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>put('IfcPropertySingleValue',scalar('IfcIdentifier',k),null,typeof v==='number'?real(v):text(v),null)));
 const attach=(entity:any,id:string,values:Record<string,string|number>)=>{const p=pset(id,values);put('IfcRelDefinesByProperties',...root(id+'/defines'),[entity],p);return p;};
 const context=put('IfcGeometricRepresentationContext',label('Model'),label('Model'),scalar('IfcDimensionCount',3),real(1e-7),axis(),dir([0,1,0]));
 const units=put('IfcUnitAssignment',[put('IfcSIUnit',en('IfcUnitEnum','LENGTHUNIT'),null,en('IfcSIUnitName','METRE'))]);
 const project=put('IfcProject',...root('project',m.id),null,null,null,[context],units);
 attach(project,'project',{SourceId:m.id,Revision:m.revision,Profile:m.metadata.sourceProfile,Units:'m',Axes:'Z-up',ModelDigest:m.metadata.modelDigest,BindingDigest:m.metadata.bindingDigest,StudyRevision:m.metadata.studyRevision});
 const sitePlace=place(null),site=put('IfcSite',...root('site'),null,sitePlace,null,null,en('IfcElementCompositionEnum','ELEMENT'),null,null,null,null,null);
 const buildingPlace=place(sitePlace),building=put('IfcBuilding',...root('building'),null,buildingPlace,null,null,en('IfcElementCompositionEnum','ELEMENT'),null,null,null);
 const aggregate=(id:string,parent:any,children:any[])=>put('IfcRelAggregates',...root(id),parent,children);
 aggregate('project/site',project,[site]);aggregate('site/building',site,[building]);
 const levels=new Map<string,any>(),placements=new Map<string,any>();
 for(const l of m.levels){const p=place(buildingPlace,[0,0,l.elevation]);placements.set(l.id,p);const e=put('IfcBuildingStorey',...root(l.id),null,p,null,null,en('IfcElementCompositionEnum','ELEMENT'),num(l.elevation));attach(e,l.id,{SourceId:l.id});levels.set(l.id,e);}
 aggregate('building/levels',building,[...levels.values()]);
 const nativeTypes=new Map<string,any>();
 for(const t of m.types){const properties=pset('type/'+t.id,{SourceId:t.id,Family:t.family,...t.parameters});
  const nt=t.family==='pump'?put('IfcPumpType',...root('type/'+t.id),null,[properties],null,scalar('IfcIdentifier',t.id),label(t.family),en('IfcPumpTypeEnum','MULTISTAGE')):put('IfcBuildingElementProxyType',...root('type/'+t.id),null,[properties],null,scalar('IfcIdentifier',t.id),label(t.family),en('IfcBuildingElementProxyTypeEnum','USERDEFINED'));
  nativeTypes.set(t.id,nt);
 }
 const entities=new Map<string,any>(),elementPlacements=new Map<string,any>();
 const shapeRep=(mesh:Mesh,role:string)=>{
  const coords=put('IfcCartesianPointList3D',Array.from({length:mesh.positions.length/3},(_,i)=>mesh.positions.slice(i*3,i*3+3).map(num)),null);
  const faces=put('IfcTriangulatedFaceSet',coords,null,scalar('IfcBoolean',true),Array.from({length:mesh.indices.length/3},(_,i)=>mesh.indices.slice(i*3,i*3+3).map(n=>scalar('IfcPositiveInteger',n+1))),null);
  return put('IfcShapeRepresentation',context,label(role),label('Tessellation'),[faces]);
 };
 const repr=(e:Element)=>put('IfcProductDefinitionShape',null,null,[shapeRep(body(m,e),'Body'),...envelopes(m,e).map(v=>shapeRep(v.mesh,v.role))]);
 // Parents precede native opening/door child placements. Source order is explicit.
 const ordered=[...m.elements].sort((a,b)=>(a.hostId?1:a.fillsId?2:0)-(b.hostId?1:b.fillsId?2:0));
 for(const e of ordered){
  const host=e.hostId?m.elements.find(x=>x.id===e.hostId):e.fillsId?m.elements.find(x=>x.id===e.fillsId):undefined;
  const base=host?elementPlacements.get(host.id):e.levelId==='site'?sitePlace:placements.get(e.levelId),level=m.levels.find(l=>l.id===e.levelId);
  if(!base)throw Error('MISSING_NATIVE_PARENT');
  const pos=host?local(host,e.position):[e.position[0],e.position[1],e.position[2]-(level?.elevation??0)] as V3;
  const ownPlace=place(base,pos,e.yaw-(host?.yaw??0));elementPlacements.set(e.id,ownPlace);
  const common=[...root(e.id,e.name),label(e.kind),ownPlace,repr(e)],tag=scalar('IfcIdentifier',e.id),p=parameters(m,e);let entity:any;
  if(e.kind==='wall')entity=put('IfcWall',...common,tag,en('IfcWallTypeEnum','STANDARD'));
  else if(e.kind==='slab'||e.kind==='roof')entity=put('IfcSlab',...common,tag,en('IfcSlabTypeEnum',e.kind==='roof'?'ROOF':'FLOOR'));
  else if(e.kind==='opening')entity=put('IfcOpeningElement',...common,tag,en('IfcOpeningElementTypeEnum','OPENING'));
  else if(e.kind==='door')entity=put('IfcDoor',...common,tag,num(Number(p.height)),num(Number(p.length)),en('IfcDoorTypeEnum','DOOR'),en('IfcDoorTypeOperationEnum','SINGLE_SWING_LEFT'),null);
  else if(e.kind==='pump')entity=put('IfcPump',...common,tag,en('IfcPumpTypeEnum','MULTISTAGE'));
  else if(e.kind==='space')entity=put('IfcSpace',...common,label(e.name),en('IfcElementCompositionEnum','ELEMENT'),en('IfcSpaceTypeEnum','INTERNAL'),null);
  else if(e.kind==='vessel')entity=put('IfcTank',...common,tag,en('IfcTankTypeEnum','PRESSUREVESSEL'));
  else if(e.kind==='pipe')entity=put('IfcPipeSegment',...common,tag,en('IfcPipeSegmentTypeEnum','RIGIDSEGMENT'));
  else entity=put('IfcBuildingElementProxy',...common,tag,en('IfcBuildingElementProxyTypeEnum','USERDEFINED'));
  entities.set(e.id,entity);
  attach(entity,e.id,{SourceId:e.id,Kind:e.kind,Disposition:e.disposition,LevelId:e.levelId,...(e.componentId?{ComponentId:e.componentId}:{}),...(e.memberId?{MemberId:e.memberId}:{}),...(e.ownerId?{OwnerId:e.ownerId}:{}),...(e.spaceIds?{AdjacentSpaces:e.spaceIds.join('|')}:{}),...Object.fromEntries(Object.entries(e.parameters).map(([k,v])=>['Parameter.'+k,v]))});
  if(e.typeId)put('IfcRelDefinesByType',...root(e.id+'/type'),[entity],nativeTypes.get(e.typeId));
 }
 for(const l of [...m.levels.map(l=>l.id),'site']){const set=m.elements.filter(e=>e.levelId===l&&e.kind!=='opening'&&e.kind!=='space').map(e=>entities.get(e.id));if(set.length)put('IfcRelContainedInSpatialStructure',...root(l+'/contains'),set,l==='site'?site:levels.get(l));}
 for(const e of m.elements){if(e.kind==='space')aggregate(e.id+'/spatial',e.levelId==='site'?site:levels.get(e.levelId),[entities.get(e.id)]);
  if(e.hostId)put('IfcRelVoidsElement',...root(e.id+'/voids'),entities.get(e.hostId),entities.get(e.id));
  if(e.fillsId)put('IfcRelFillsElement',...root(e.id+'/fills'),entities.get(e.fillsId),entities.get(e.id));
  if(e.fillsId)for(const spaceId of e.spaceIds??[])put('IfcRelSpaceBoundary',...root(e.id+'/boundary/'+spaceId),entities.get(spaceId),entities.get(e.id),null,en('IfcPhysicalOrVirtualEnum','PHYSICAL'),en('IfcInternalOrExternalEnum','INTERNAL'));
  if(e.kind==='pump')for(const [suffix,x,y] of [['inlet',Number(parameters(m,e).length)*.1,0],['outlet',Number(parameters(m,e).length)*.34,Number(parameters(m,e).width)]] as const){
   const portPlace=put('IfcLocalPlacement',elementPlacements.get(e.id),put('IfcAxis2Placement3D',xyz([x,y,Number(parameters(m,e).height)*.52]),dir([0,suffix==='inlet'?-1:1,0]),dir([1,0,0])));
   const p=put('IfcDistributionPort',...root(e.id+'/'+suffix),label('Authored physical pump nozzle'),portPlace,null,en('IfcFlowDirectionEnum',suffix==='inlet'?'SINK':'SOURCE'),en('IfcDistributionPortTypeEnum','PIPE'),en('IfcDistributionSystemEnum','USERDEFINED'));
   attach(p,e.id+'/'+suffix,{SourceId:e.id+'/'+suffix,ComponentPort:(e.componentId??e.id)+'.'+suffix});put('IfcRelNests',...root(e.id+'/'+suffix+'/owner'),entities.get(e.id),[p]);
  }
 }
 const bytes=api.SaveModel(model);api.CloseModel(model);return bytes;
}

type Parsed={model:Model;nativeBodies:Map<string,Mesh>;globalIds:Map<string,string>;nativeEntityCounts:Record<string,number>;nativeTessellation:{meshes:number;triangles:number}};
const list=(api:W.IfcAPI,id:number,t:number)=>{const v=api.GetLineIDsWithType(id,t);return Array.from({length:v.size()},(_,i)=>api.GetLine(id,v.get(i),false) as any);};
const round=(a:number[])=>a.map(x=>Math.round(x*1e7)/1e7);
export async function read(bytes:Uint8Array,options={checkBody:true}):Promise<Parsed>{
 if(bytes.length>20_000_000)throw Error('SOURCE_BYTE_LIMIT');if(!new TextDecoder().decode(bytes.slice(0,4096)).includes("'IFC4X3_ADD2'"))throw Error('UNSUPPORTED_SCHEMA');
 const a=await api(),id=a.OpenModel(bytes,settings);if(id<0||a.GetModelSchema(id)!==SCHEMA)throw Error('SCHEMA_REFUSAL');
 try{
 const get=(ref:any)=>a.GetLine(id,typeof ref==='number'?ref:ref.value,false) as any;
 const supportedEntities=new Set('IfcAxis2Placement3D IfcBuilding IfcBuildingElementProxy IfcBuildingElementProxyType IfcBuildingStorey IfcCartesianPoint IfcCartesianPointList3D IfcDirection IfcDistributionPort IfcDoor IfcGeometricRepresentationContext IfcLocalPlacement IfcOpeningElement IfcPipeSegment IfcProductDefinitionShape IfcProject IfcPropertySet IfcPropertySingleValue IfcPump IfcPumpType IfcRelAggregates IfcRelContainedInSpatialStructure IfcRelDefinesByProperties IfcRelDefinesByType IfcRelFillsElement IfcRelNests IfcRelSpaceBoundary IfcRelVoidsElement IfcSIUnit IfcShapeRepresentation IfcSite IfcSlab IfcSpace IfcTank IfcTriangulatedFaceSet IfcUnitAssignment IfcWall'.split(' '));
 const allLines=a.GetAllLines(id);if(allLines.size()>250000)throw Error('SOURCE_ENTITY_LIMIT');for(let i=0;i<allLines.size();i++){const name=a.GetNameFromTypeCode(get(allLines.get(i)).type);if(!supportedEntities.has(name))throw Error('UNSUPPORTED_SOURCE_ENTITY:'+name);}
 const propSet=(ref:any):Record<string,string|number>=>{const s=get(ref);if(s.Name.value!=='LeitbildAuthoring')throw Error('UNSUPPORTED_PROFILE_PROPERTYSET');return Object.fromEntries(s.HasProperties.map((x:any)=>{const p=get(x);return [p.Name.value,p.NominalValue.value];}));};
 const properties=new Map<number,Record<string,string|number>>();for(const r of list(a,id,W.IFCRELDEFINESBYPROPERTIES))for(const o of r.RelatedObjects){if(properties.has(o.value))throw Error('DUPLICATE_SOURCE_PROPERTYSET');properties.set(o.value,propSet(r.RelatingPropertyDefinition));}
 const projects=list(a,id,W.IFCPROJECT);if(projects.length!==1)throw Error('ONE_PROJECT_REQUIRED');const meta=properties.get(projects[0].expressID);if(meta?.Profile!=='leitbild.ifc-authoring-trial-1')throw Error('UNSUPPORTED_SOURCE_PROFILE');
 const exactKeys=(p:Record<string,string|number>,allowed:string[])=>{for(const k of Object.keys(p))if(!allowed.includes(k))throw Error('UNSUPPORTED_SOURCE_PROPERTY:'+k);};
 exactKeys(meta,['SourceId','Revision','Profile','Units','Axes','ModelDigest','BindingDigest','StudyRevision']);
 const unit=get(get(projects[0].UnitsInContext).Units[0]);if(unit.Name.value!=='METRE'||unit.Prefix!==null)throw Error('UNSUPPORTED_UNITS');
 const globalIds=new Map<string,string>(),allIds=new Set<string>();
 const roots=a.GetLineIDsWithType(id,W.IFCROOT,true);for(let i=0;i<roots.size();i++){const r=get(roots.get(i)),g=r.GlobalId?.value;if(typeof g!=='string'||!/^[0-3][0-9A-Za-z_$]{21}$/.test(g)||allIds.has(g))throw Error('INVALID_OR_DUPLICATE_GLOBAL_ID');allIds.add(g);const p=properties.get(r.expressID);if(p?.SourceId)globalIds.set(String(p.SourceId),g);}
 const levels=list(a,id,W.IFCBUILDINGSTOREY).map(l=>({id:String(properties.get(l.expressID)!.SourceId),elevation:l.Elevation.value}));
 const types:PhysicalType[]=[],typeExpress=new Map<number,string>();
 for(const t of [...list(a,id,W.IFCPUMPTYPE),...list(a,id,W.IFCBUILDINGELEMENTPROXYTYPE)]){const p=propSet(t.HasPropertySets[0]);exactKeys(p,['SourceId','Family','length','width','height','serviceSide','path','radius','circuits']);if(t.HasPropertySets.length!==1)throw Error('UNSUPPORTED_ADDITIONAL_TYPE_PROPERTYSET');const params=Object.fromEntries(Object.entries(p).filter(([k])=>!['SourceId','Family'].includes(k)));types.push({id:String(p.SourceId),family:p.Family as PhysicalType['family'],parameters:params});typeExpress.set(t.expressID,String(p.SourceId));}
 const typed=new Map<number,string>();for(const r of list(a,id,W.IFCRELDEFINESBYTYPE))for(const o of r.RelatedObjects)typed.set(o.value,typeExpress.get(r.RelatingType.value)!);
 const host=new Map<number,string>(),fill=new Map<number,string>();for(const r of list(a,id,W.IFCRELVOIDSELEMENT))host.set(r.RelatedOpeningElement.value,String(properties.get(r.RelatingBuildingElement.value)!.SourceId));for(const r of list(a,id,W.IFCRELFILLSELEMENT))fill.set(r.RelatedBuildingElement.value,String(properties.get(r.RelatingOpeningElement.value)!.SourceId));
 const placement=(ref:any):{position:V3;yaw:number}=>{if(!ref)return {position:[0,0,0],yaw:0};const p=get(ref),axis=get(p.RelativePlacement),v=get(axis.Location).Coordinates.map((n:any)=>n.value) as V3,z=axis.Axis?get(axis.Axis).DirectionRatios.map((n:any)=>n.value):[0,0,1];if(JSON.stringify(z)!=='[0,0,1]')throw Error('UNSUPPORTED_TILTED_PLACEMENT');const x=axis.RefDirection?get(axis.RefDirection).DirectionRatios.map((n:any)=>n.value):[1,0,0],parent=placement(p.PlacementRelTo);return {position:world({...parent} as Element,v),yaw:parent.yaw+Math.atan2(x[1],x[0])};};
 const nativeBodies=new Map<string,Mesh>(),nativeEnvelopes=new Map<string,Map<string,Mesh>>(),elements:Element[]=[];
 const kinds=[W.IFCWALL,W.IFCSLAB,W.IFCOPENINGELEMENT,W.IFCDOOR,W.IFCPUMP,W.IFCSPACE,W.IFCTANK,W.IFCPIPESEGMENT,W.IFCBUILDINGELEMENTPROXY];
 for(const kind of kinds)for(const n of list(a,id,kind)){const p=properties.get(n.expressID);if(!p?.SourceId)throw Error('UNPROFILED_ELEMENT');exactKeys(p,['SourceId','Kind','Disposition','LevelId','ComponentId','MemberId','OwnerId','AdjacentSpaces',...['length','width','height','serviceSide','path','radius','circuits'].map(k=>'Parameter.'+k)]);const nativeType=({wall:W.IFCWALL,slab:W.IFCSLAB,roof:W.IFCSLAB,opening:W.IFCOPENINGELEMENT,door:W.IFCDOOR,pump:W.IFCPUMP,space:W.IFCSPACE,vessel:W.IFCTANK,pipe:W.IFCPIPESEGMENT} as Record<string,number>)[String(p.Kind)]??W.IFCBUILDINGELEMENTPROXY;if(nativeType!==kind)throw Error('NATIVE_CLASSIFICATION_MISMATCH');if(kind===W.IFCDOOR&&(Math.abs(n.OverallHeight.value-Number(p['Parameter.height']))>1e-7||Math.abs(n.OverallWidth.value-Number(p['Parameter.length']))>1e-7))throw Error('NATIVE_DOOR_DIMENSION_MISMATCH');const eid=String(p.SourceId);for(const ref of get(n.Representation).Representations){const rep=get(ref),face=get(rep.Items[0]);if(face.type!==W.IFCTRIANGULATEDFACESET)throw Error('UNSUPPORTED_NATIVE_GEOMETRY');if(!['Body','ServiceEnvelope','RemovalEnvelope'].includes(rep.RepresentationIdentifier.value))throw Error('UNSUPPORTED_REPRESENTATION_ROLE');const positions=get(face.Coordinates).CoordList.flatMap((r:any[])=>r.map(x=>x.value)),indices=face.CoordIndex.flatMap((r:any[])=>r.map(x=>x.value-1));if(rep.RepresentationIdentifier.value==='Body')nativeBodies.set(eid,{positions,indices});else{if(!nativeEnvelopes.has(eid))nativeEnvelopes.set(eid,new Map());nativeEnvelopes.get(eid)!.set(rep.RepresentationIdentifier.value,{positions,indices});}}
  const e:Element={id:eid,name:n.Name.value,kind:p.Kind as Element['kind'],levelId:String(p.LevelId),...placement(n.ObjectPlacement),parameters:Object.fromEntries(Object.entries(p).filter(([k])=>k.startsWith('Parameter.')).map(([k,v])=>[k.slice(10),v])),disposition:p.Disposition as Element['disposition'],...(typed.has(n.expressID)?{typeId:typed.get(n.expressID)}:{}),...(p.ComponentId?{componentId:String(p.ComponentId)}:{}),...(p.MemberId?{memberId:String(p.MemberId)}:{}),...(p.OwnerId?{ownerId:String(p.OwnerId)}:{}),...(host.has(n.expressID)?{hostId:host.get(n.expressID)}:{}),...(fill.has(n.expressID)?{fillsId:fill.get(n.expressID)}:{}),...(p.AdjacentSpaces?{spaceIds:String(p.AdjacentSpaces).split('|')}:{})};elements.push(e);
 }
 const model:Model={id:String(meta.SourceId),revision:String(meta.Revision),levels,types,elements,metadata:{modelDigest:String(meta.ModelDigest),bindingDigest:String(meta.BindingDigest),sourceProfile:String(meta.Profile),studyRevision:String(meta.StudyRevision)}};validate(model);
 const containers=new Map<string,string>();for(const r of list(a,id,W.IFCRELCONTAINEDINSPATIALSTRUCTURE)){const owner=get(r.RelatingStructure),container=owner.type===W.IFCSITE?'site':String(properties.get(owner.expressID)?.SourceId);for(const obj of r.RelatedElements){const key=String(properties.get(obj.value)?.SourceId);if(containers.has(key))throw Error('MULTIPLE_PRIMARY_CONTAINERS');containers.set(key,container);}}
 for(const e of elements.filter(e=>!['space','opening'].includes(e.kind)))if(containers.get(e.id)!==e.levelId)throw Error('NATIVE_SPATIAL_CONTAINER_MISMATCH');
 const boundaries=list(a,id,W.IFCRELSPACEBOUNDARY);for(const e of elements.filter(e=>e.fillsId)){const native=boundaries.filter(r=>String(properties.get(r.RelatedBuildingElement.value)?.SourceId)===e.id).map(r=>String(properties.get(r.RelatingSpace.value)?.SourceId)).sort();if(JSON.stringify(native)!==JSON.stringify([...(e.spaceIds??[])].sort()))throw Error('SPACE_ADJACENCY_MISMATCH');}
 const portOwners=new Map<number,number>();for(const r of list(a,id,W.IFCRELNESTS))for(const o of r.RelatedObjects)portOwners.set(o.value,r.RelatingObject.value);const ports=list(a,id,W.IFCDISTRIBUTIONPORT);
 if(ports.length!==elements.filter(e=>e.kind==='pump').length*2)throw Error('PORT_COUNT_MISMATCH');
 for(const p of ports){const ownerId=String(properties.get(portOwners.get(p.expressID)!)?.SourceId),owner=elements.find(e=>e.id===ownerId);if(!owner)throw Error('PORT_OWNER_MISMATCH');const pose=get(p.ObjectPlacement),ax=get(pose.RelativePlacement),point=get(ax.Location).Coordinates.map((x:any)=>x.value) as V3,direction=get(ax.Axis).DirectionRatios.map((x:any)=>x.value) as V3,portId=String(properties.get(p.expressID)?.SourceId),expected=interfaces(model,owner).find(i=>i.id===portId);if(!expected||hash(round(world(owner,point)))!==hash(round(expected.position))||hash(round(rotate(direction,owner.yaw)))!==hash(round(expected.direction)))throw Error('PORT_PARAMETER_MISMATCH');}
 if(options.checkBody)for(const e of elements){const expected=body(model,e),actual=nativeBodies.get(e.id)!;if(hash({positions:round(expected.positions),indices:expected.indices})!==hash({positions:round(actual.positions),indices:actual.indices}))throw Error('AUTHORITATIVE_PARAMETER_BODY_MISMATCH:'+e.id);for(const env of envelopes(model,e)){const native=nativeEnvelopes.get(e.id)?.get(env.role);if(!native||hash({positions:round(env.mesh.positions),indices:env.mesh.indices})!==hash({positions:round(native.positions),indices:native.indices}))throw Error('ENVELOPE_PARAMETER_MISMATCH:'+e.id);}}
 const typesCount=[W.IFCPROJECT,W.IFCSITE,W.IFCBUILDINGSTOREY,W.IFCWALL,W.IFCPUMP,W.IFCDISTRIBUTIONPORT,W.IFCRELVOIDSELEMENT,W.IFCRELFILLSELEMENT,W.IFCRELSPACEBOUNDARY,W.IFCRELDEFINESBYTYPE,W.IFCRELCONTAINEDINSPATIALSTRUCTURE,W.IFCTRIANGULATEDFACESET];
 const nativeEntityCounts=Object.fromEntries(typesCount.map(t=>[a.GetNameFromTypeCode(t),list(a,id,t).length]));let meshes=0,triangles=0;a.StreamAllMeshes(id,m=>{meshes++;for(let i=0;i<m.geometries.size();i++){const g=a.GetGeometry(id,m.geometries.get(i).geometryExpressID);triangles+=g.GetIndexDataSize()/3;g.delete();}});
 return {model,nativeBodies,globalIds,nativeEntityCounts,nativeTessellation:{meshes,triangles}};
 }finally{a.CloseModel(id);}
}
export async function inspectImport(bytes:Uint8Array){
 const a=await api(),id=a.OpenModel(bytes,settings);if(id<0)throw Error('IMPORT_PARSE_REFUSED');
 try{const facts:Record<string,number>={};for(const kind of [W.IFCROOT,W.IFCPUMP,W.IFCTANK,W.IFCWALL,W.IFCDOOR,W.IFCOPENINGELEMENT,W.IFCDISTRIBUTIONPORT,W.IFCRELVOIDSELEMENT,W.IFCRELFILLSELEMENT,W.IFCSHAPEASPECT]){const v=a.GetLineIDsWithType(id,kind,kind===W.IFCROOT);facts[a.GetNameFromTypeCode(kind)]=v.size();}const entityTypes:Record<string,number>={};const ids=a.GetAllLines(id);for(let i=0;i<ids.size();i++){const n=a.GetNameFromTypeCode((a.GetLine(id,ids.get(i),false) as any).type);entityTypes[n]=(entityTypes[n]??0)+1;}let meshes=0,triangles=0;const nativeBounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity],meshDigests:string[]=[];a.StreamAllMeshes(id,m=>{meshes++;for(let i=0;i<m.geometries.size();i++){const item=m.geometries.get(i),g=a.GetGeometry(id,item.geometryExpressID),data=a.GetVertexArray(g.GetVertexData(),g.GetVertexDataSize()),t=item.flatTransformation,index=a.GetIndexArray(g.GetIndexData(),g.GetIndexDataSize());meshDigests.push(hash({vertices:Array.from(data),indices:Array.from(index),transform:Array.from(t)}));for(let j=0;j<data.length;j+=6){for(let k=0;k<3;k++){const v=t[k]!*data[j]!+t[4+k]!*data[j+1]!+t[8+k]!*data[j+2]!+t[12+k]!;nativeBounds[k]=Math.min(nativeBounds[k]!,v);nativeBounds[k+3]=Math.max(nativeBounds[k+3]!,v);}}triangles+=g.GetIndexDataSize()/3;g.delete();}});return {sha256:hash(bytes),schema:a.GetModelSchema(id),facts,entityTypes,nativeTessellation:{meshes,triangles,nativeBounds,meshFactsSha256:hash(meshDigests)},editability:'read-only retained raw IFC; no trial family parameters; no claim to recover construction history',policy:'unsupported trial-profile source is refused for editing; original native geometry/relations retained verbatim'};}finally{a.CloseModel(id);}
}
