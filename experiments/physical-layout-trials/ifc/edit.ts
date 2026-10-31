import {read,write,api} from './ifc.ts';
import {clone,hash,parameters,world,body,interfaces,envelopes,type Model,type Element} from './model.ts';

export type Edit={kind:'add-door'}|{kind:'raise-roof';height:number}|{kind:'raise-deck';elevation:number;unsupportedDependency?:boolean}|{kind:'pump-type';factor:number}|{kind:'pump-variant';extraLength:number}|{kind:'move-pump';east:number};
export const requirements={id:'independent-height-requirement',revision:'requirements-1',maxClearHeightM:9};
const rounded=(x:unknown):unknown=>typeof x==='number'?Math.round(x*1e7)/1e7:Array.isArray(x)?x.map(rounded):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,rounded(v)])):x;
export function semanticSnapshot(m:Model){return Object.fromEntries(m.elements.map(e=>[e.id,rounded({element:e,effective:parameters(m,e),interfaces:interfaces(m,e),envelopes:envelopes(m,e),bodyHash:hash(rounded(body(m,e)))} )]));}
export function changedElements(a:Model,b:Model){const x=semanticSnapshot(a),y=semanticSnapshot(b);return [...new Set([...Object.keys(x),...Object.keys(y)])].filter(id=>hash(x[id])!==hash(y[id])).sort();}
export function candidate(original:Model,edit:Edit){
 const m=clone(original),element=(id:string)=>{const e=m.elements.find(e=>e.id===id);if(!e)throw Error('MISSING_TARGET:'+id);return e;};let intended:string[]=[];const impacts:string[]=[];
 switch(edit.kind){
  case 'add-door':{
   const wall=element('edit-wall');if(m.elements.some(e=>e.id==='access-door'))throw Error('DOOR_ALREADY_EXISTS');
   const opening:Element={id:'access-opening',name:'Additional access opening',kind:'opening',levelId:wall.levelId,position:world(wall,[7,-.01,0]),yaw:wall.yaw,parameters:{length:1.4,width:.32,height:2.7},hostId:wall.id,spaceIds:['edit-space-a','edit-space-b'],disposition:'installed'};
   m.elements.push(opening,{id:'access-door',name:'Additional access door',kind:'door',levelId:wall.levelId,position:opening.position,yaw:wall.yaw,parameters:{length:1.4,width:.06,height:2.7},fillsId:opening.id,spaceIds:opening.spaceIds,disposition:'installed'});intended=['edit-wall','access-opening','access-door'];impacts.push('Access/portal applicability needs review; fire/egress classification not inferred');break;
  }
  case 'raise-roof':{
   if(edit.height>requirements.maxClearHeightM)throw Error('INDEPENDENT_HEIGHT_LIMIT');if(edit.height<=0)throw Error('INVALID_ROOF_HEIGHT');
   element('edit-roof').position[2]=edit.height;for(const id of ['edit-wall','edit-space-a','edit-space-b'])element(id).parameters.height=edit.height;
   intended=['edit-roof','edit-wall','edit-space-a','edit-space-b'];impacts.push('Crane/beam/handling headroom requires evidence; roof-only does not move deck, crane or pumps');break;
  }
  case 'raise-deck':{
   if(edit.unsupportedDependency)throw Error('UNSUPPORTED_DECK_DEPENDENCY');const delta=edit.elevation-3;
   for(const id of ['edit-deck','edit-landing'])element(id).position[2]+=delta;
   for(const id of ['edit-stair','edit-riser','edit-support'])element(id).parameters.height=Number(element(id).parameters.height)+delta;
   intended=['edit-deck','edit-landing','edit-stair','edit-riser','edit-support'];impacts.push('Enumerated stair/landing/riser/support dependency set only; arbitrary structure propagation unsupported');break;
  }
  case 'pump-type':{
   if(edit.factor<=0||edit.factor>2)throw Error('INVALID_TYPE_EDIT');const t=m.types.find(t=>t.id==='family-feed-pump')!;t.parameters.length=Number(t.parameters.length)*edit.factor;intended=m.elements.filter(e=>e.typeId===t.id).map(e=>e.id);impacts.push('Physical nozzle/service-envelope changes; routes stale, no numerical retuning');break;
  }
  case 'pump-variant':{
   const e=element('mfw-a');e.parameters.length=Number(parameters(m,e).length)+edit.extraLength;intended=[e.id];impacts.push('A-only override; inherited B dimensions preserved');break;
  }
  case 'move-pump':{const e=element('mfw-a');e.position[0]+=edit.east;intended=[e.id];impacts.push('Nozzle/interface/envelope moved; routing/support/access studies stale, graph parameters preserved');break;}
 }
 m.revision='physical-'+hash({base:original.revision,edit}).slice(0,12);m.metadata.studyRevision='stale:'+original.revision;return {model:m,intended:intended.sort(),impacts};
}
export async function admit(base:Uint8Array,expectedBaseSha:string,edit:Edit,options:{modelDigest?:string;studyBaseline?:string;tamper?:(m:Model)=>void}={}){
 if(hash(base)!==expectedBaseSha)throw Error('EXPECTED_BASE_CONFLICT');const parsed=await read(base),before=parsed.model;
 if(options.modelDigest!==undefined&&options.modelDigest!==before.metadata.modelDigest)throw Error('STALE_MODEL_BINDING');
 if(options.studyBaseline!==undefined&&options.studyBaseline!==before.revision)throw Error('STALE_STUDY_BASELINE');
 const c=candidate(before,edit);options.tamper?.(c.model);const changed=changedElements(before,c.model);
 if(JSON.stringify(changed)!==JSON.stringify(c.intended))throw Error('COLLATERAL_CHANGE:'+changed.join(','));
 if(c.model.metadata.modelDigest!==before.metadata.modelDigest||c.model.metadata.bindingDigest!==before.metadata.bindingDigest)throw Error('PROCESS_OR_BINDING_MUTATION');
 const bytes=write(await api(),c.model),reopened=await read(bytes);const reopenedChanges=changedElements(before,reopened.model);
 if(JSON.stringify(reopenedChanges)!==JSON.stringify(c.intended))throw Error('SAVE_REOPEN_COLLATERAL');
 const unchanged=before.elements.filter(e=>!changed.includes(e.id));if(unchanged.some(e=>parsed.globalIds.get(e.id)!==reopened.globalIds.get(e.id)))throw Error('UNRELATED_GLOBAL_ID_CHANGED');
 return {bytes,receipt:{kind:edit.kind,beforeSha:hash(base),afterSha:hash(bytes),beforeRevision:before.revision,afterRevision:reopened.model.revision,intended:c.intended,actual:reopenedChanges,unchangedIdentityCount:unchanged.length,studyApplicability:'old results retained against old source; stale for new design',impacts:c.impacts,interfacesBefore:before.elements.filter(e=>changed.includes(e.id)).flatMap(e=>interfaces(before,e)),interfacesAfter:reopened.model.elements.filter(e=>changed.includes(e.id)).flatMap(e=>interfaces(reopened.model,e))}};
}
