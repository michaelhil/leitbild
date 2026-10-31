import {createHash} from 'node:crypto';
export type V3=[number,number,number];
export type Box={x:number;y:number;w:number;h:number};
export type Level='operating'|'lower';
export type Equipment=Box & {id:string;name:string;tag:string;level:Level;kind:'hp'|'lp'|'generator'|'exciter'|'msr'|'stop-valve'|'condenser'|'feed-pump'|'condensate-pump';componentId?:string;binding:'component'|'part-of'|'illustrative';zBase:number;zTop:number;note:string};
export type Kind='equipment'|'wall'|'opening'|'door'|'assembly'|'slab'|'stair'|'roof'|'riser'|'support'|'space'|'context'|'pipe';
export type Parameters={length:number;width:number;height:number};
export type Element={id:string;label:string;kind:Kind;levelId:string;scope:'unit'|'site';pose:{position:V3;yaw:number};dimensions?:Parameters;typeId?:string;override?:Partial<Parameters>;equipmentKind?:Equipment['kind'];binding?:{componentId:string;relation:'component'|'part-of'};hostId?:string;fillsId?:string;assemblyId?:string;spaceIds?:string[];disposition:'installed'|'proposed'|'removed'|'temporary';door?:{swing:number};dependsOn?:string[];holes?:{x:number;y:number;width:number;length:number}[];path?:V3[]};
export type Source={schema:'leitbild-native-authoring-trial';revision:string;designId:string;units:'m';axes:'Z-up';configuration:'installed';modelRequirement:{modelRef:string;digest:string};levels:{id:string;elevation:number;cutHeight:number}[];types:{id:string;kind:Equipment['kind'];parameters:Parameters}[];elements:Element[];requirements:{id:string;targetId:string;dimension:'height';max:number;owner:string}[];instances:{id:string;siteId:string;memberId:string;ownerId:string;position:V3}[];imports:{id:string;path:string;sha256:string;ownership:'raw-read-only'}[];circuits:{id:string;fromElementId:string;firstSupportId:string}[];bindingsRevision:string;studies:{id:string;designRevision:string;applicability:'current'|'stale'}[]};
export const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
export const clone=<T>(x:T):T=>structuredClone(x);
export const canonical=(x:unknown):string=>JSON.stringify(sort(x));
const sort=(x:any):any=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const fail=(message:string):never=>{throw Error(message)};
const keys=(value:any,names:string[],name:string)=>{if(!value||typeof value!=='object'||Array.isArray(value))fail(`invalid-object:${name}`);for(const k of Object.keys(value))if(!names.includes(k))fail(`unknown-field:${name}.${k}`);};
const finite=(v:any,name:string)=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e6)fail(`invalid-number:${name}`);};
const identifier=(v:any,name:string)=>{if(typeof v!=='string'||!v.length||v.length>200||!/^[-\w:/ .]+$/.test(v))fail(`invalid-id:${name}`);};
export function parameters(s:Source,e:Element):Parameters{const t=e.typeId?s.types.find(t=>t.id===e.typeId):undefined;const p={...(t?.parameters??e.dimensions),...e.override};if(!p.length||!p.width||!p.height)fail(`missing-dimensions:${e.id}`);return p as Parameters;}
export function validate(input:unknown):Source{
 const s=input as Source;keys(s,['schema','revision','designId','units','axes','configuration','modelRequirement','levels','types','elements','requirements','instances','imports','circuits','bindingsRevision','studies'],'source');
 if(s.schema!=='leitbild-native-authoring-trial'||s.units!=='m'||s.axes!=='Z-up'||s.configuration!=='installed')fail('unsupported-native-profile');
 for(const n of['revision','designId','bindingsRevision'] as const)identifier(s[n],n);
 keys(s.modelRequirement,['modelRef','digest'],'modelRequirement');if(!/^[a-f0-9]{64}$/.test(s.modelRequirement.digest))fail('invalid-model-digest');identifier(s.modelRequirement.modelRef,'modelRef');
 for(const n of['levels','types','elements','requirements','instances','imports','circuits','studies'] as const)if(!Array.isArray(s[n])||s[n].length>10000)fail(`invalid-list:${n}`);
 const ids=new Set<string>();for(const x of [...s.levels,...s.types,...s.elements,...s.requirements]){identifier(x.id,'id');if(ids.has(x.id))fail(`duplicate-id:${x.id}`);ids.add(x.id);}
 for(const l of s.levels){keys(l,['id','elevation','cutHeight'],'level');finite(l.elevation,l.id);finite(l.cutHeight,l.id);}
 for(const t of s.types){keys(t,['id','kind','parameters'],'type');keys(t.parameters,['length','width','height'],'type.parameters');for(const v of Object.values(t.parameters)){finite(v,t.id);if(v<=0)fail(`nonpositive:${t.id}`);}}
 for(const e of s.elements){keys(e,['id','label','kind','levelId','scope','pose','dimensions','typeId','override','equipmentKind','binding','hostId','fillsId','assemblyId','spaceIds','disposition','door','dependsOn','holes','path'],'element');
  if(typeof e.label!=='string'||!e.label.length||e.label.length>300)fail(`invalid-label:${e.id}`);if(!['equipment','wall','opening','door','assembly','slab','stair','roof','riser','support','space','context','pipe'].includes(e.kind))fail(`unsupported-kind:${e.kind}`);if(!['unit','site'].includes(e.scope))fail(`invalid-scope:${e.id}`);
  if(e.path){if(e.kind!=='pipe'||e.path.length<2||e.path.length>1000)fail('unsupported-path');for(const p of e.path){if(p.length!==3)fail('invalid-path-point');p.forEach(v=>finite(v,e.id));}}
  if(!['installed','proposed','removed','temporary'].includes(e.disposition))fail(`invalid-disposition:${e.id}`);if(e.levelId!=='site'&&!s.levels.some(l=>l.id===e.levelId))fail(`missing-level:${e.id}`);
  keys(e.pose,['position','yaw'],'pose');if(!Array.isArray(e.pose.position)||e.pose.position.length!==3)fail(`invalid-position:${e.id}`);e.pose.position.forEach(v=>finite(v,e.id));finite(e.pose.yaw,e.id);
  if(e.typeId&&!s.types.some(t=>t.id===e.typeId))fail(`missing-type:${e.id}`);if(e.dimensions&&e.typeId)fail(`duplicate-dimension-authority:${e.id}`);if(e.override&&!e.typeId)fail(`unowned-override:${e.id}`);
  if(e.kind==='equipment'&&(!e.typeId||!e.equipmentKind||e.equipmentKind!==s.types.find(t=>t.id===e.typeId)?.kind||!['hp','lp','generator','exciter','msr','stop-valve','condenser','feed-pump','condensate-pump'].includes(e.equipmentKind)))fail(`unsupported-equipment-family:${e.id}`);
  if(e.dimensions)keys(e.dimensions,['length','width','height'],'dimensions');if(e.override)keys(e.override,['length','width','height'],'override');
  for(const v of Object.values(parameters(s,e))){finite(v,e.id);if(v<=0)fail(`nonpositive:${e.id}`);}
  if(e.hostId&&!s.elements.some(h=>h.id===e.hostId&&h.kind==='wall'))fail(`invalid-host:${e.id}`);if(e.fillsId&&!s.elements.some(h=>h.id===e.fillsId&&h.kind==='opening'))fail(`invalid-fill:${e.id}`);
  if(e.assemblyId&&!s.elements.some(h=>h.id===e.assemblyId&&h.kind==='assembly'))fail(`invalid-assembly:${e.id}`);
  if(e.fillsId&&s.elements.filter(v=>v.fillsId===e.fillsId).length!==1)fail(`multiple-fillings-for-opening:${e.fillsId}`);
  if(e.dependsOn)for(const id of e.dependsOn)if(!s.elements.some(v=>v.id===id))fail(`unsupported-dependency:${id}`);
  if(e.holes)for(const h of e.holes){keys(h,['x','y','width','length'],'hole');Object.values(h).forEach(v=>finite(v,e.id));if(h.length<=0||h.width<=0||h.x<0||h.y<0||h.x+h.length>parameters(s,e).length||h.y+h.width>parameters(s,e).width)fail(`hole-outside-plate:${e.id}`);}
  if(e.binding){keys(e.binding,['componentId','relation'],'binding');identifier(e.binding.componentId,e.id);if(!['component','part-of'].includes(e.binding.relation))fail(`invalid-binding:${e.id}`);}
  if(e.kind==='opening'){const host=s.elements.find(h=>h.id===e.hostId)??fail(`unhosted-opening:${e.id}`);const d=parameters(s,e),h=parameters(s,host);if(e.pose.position[0]<0||e.pose.position[0]+d.length>h.length||e.pose.position[2]<0||e.pose.position[2]+d.height>h.height)fail(`opening-outside-host:${e.id}`);}
 }
 for(const r of s.requirements){keys(r,['id','targetId','dimension','max','owner'],'requirement');const e=s.elements.find(e=>e.id===r.targetId)??fail(`missing-requirement-target:${r.id}`);if(parameters(s,e).height>r.max)fail(`independent-requirement:${r.id}`);}
 const inst=new Set<string>();for(const i of s.instances){const k=`${i.siteId}/${i.id}`;if(inst.has(k))fail(`duplicate-instance:${k}`);inst.add(k);}
 for(const c of s.circuits){keys(c,['id','fromElementId','firstSupportId'],'circuit');for(const id of[c.fromElementId,c.firstSupportId])if(!s.elements.some(e=>e.id===id&&e.scope==='site'))fail(`missing-shared-circuit-element:${id}`);}
 for(const i of s.imports){keys(i,['id','path','sha256','ownership'],'import');if(i.ownership!=='raw-read-only'||i.path.includes('..')||i.path.startsWith('/')||!/^[a-f0-9]{64}$/.test(i.sha256))fail('invalid-import-reference');}
 return s;
}
export const readSource=(text:string)=>validate(JSON.parse(text));
export const sourceText=(source:Source)=>JSON.stringify(validate(source),null,2)+'\n';
export function elementWorld(s:Source,e:Element):{position:V3;yaw:number}{if(!e.hostId)return e.pose;const h=s.elements.find(h=>h.id===e.hostId)!;const hp=elementWorld(s,h),[x,y,z]=e.pose.position,c=Math.cos(hp.yaw),d=Math.sin(hp.yaw);return{position:[hp.position[0]+c*x-d*y,hp.position[1]+d*x+c*y,hp.position[2]+z],yaw:hp.yaw+e.pose.yaw};}
export function semantic(s:Source){return{...s,elements:Object.fromEntries(s.elements.map(e=>[e.id,{...e,resolvedParameters:parameters(s,e),world:elementWorld(s,e)}])),types:Object.fromEntries(s.types.map(t=>[t.id,t])),levels:Object.fromEntries(s.levels.map(l=>[l.id,l])),requirements:Object.fromEntries(s.requirements.map(r=>[r.id,r]))};}
export function semanticDiff(a:Source,b:Source){const aa=semantic(a),bb=semantic(b),changes:{path:string;before:unknown;after:unknown}[]=[];function visit(x:any,y:any,path:string){if(canonical(x)===canonical(y))return;if(x&&y&&typeof x==='object'&&typeof y==='object'&&!Array.isArray(x)&&!Array.isArray(y)){for(const k of new Set([...Object.keys(x),...Object.keys(y)]))visit(x[k],y[k],`${path}/${k}`);}else changes.push({path,before:x,after:y});}visit(aa,bb,'');return changes;}
