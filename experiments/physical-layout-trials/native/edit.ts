import {clone,validate,parameters,canonical,semanticDiff,sourceText,hash,type Source,type Element} from './model.ts';
export type Command={kind:'addDoor'}|{kind:'raiseRoof';height:number}|{kind:'raiseDeck';height:number;dependencies:string[]}|{kind:'move';elementId:string;east:number}|{kind:'typeLength';typeId:string;factor:number}|{kind:'occurrenceLength';elementId:string;extra:number};
const deckDependencies=['edit-stair','edit-landing','edit-riser','edit-support'];
export function edit(source:Source,command:Command){const s=clone(source),get=(id:string)=>{const e=s.elements.find(e=>e.id===id);if(!e)throw Error(`missing-target:${id}`);return e;};let allowed:string[]=[];
 switch(command.kind){
 case 'addDoor':{if(s.elements.some(e=>e.id==='access-door'))throw Error('already-exists:access-door');const opening:Element={id:'access-door-opening',label:'Access door opening',kind:'opening',scope:'unit',levelId:'lower',hostId:'edit-wall',pose:{position:[7,0,0],yaw:0},dimensions:{length:1.4,width:.3,height:2.7},spaceIds:['edit-space','site'],disposition:'installed'};const door:Element={id:'access-door',label:'Access door',kind:'door',scope:'unit',levelId:'lower',pose:{position:[110+7*Math.cos(Math.PI/6),7*Math.sin(Math.PI/6),0],yaw:Math.PI/6+Math.PI/2},dimensions:{length:1.4,width:.07,height:2.7},fillsId:opening.id,spaceIds:['edit-space','site'],door:{swing:Math.PI/2},disposition:'installed'};s.elements.push(opening,door);allowed=[opening.id,door.id];break;}
 case 'raiseRoof':get('edit-wall').dimensions!.height=command.height;get('edit-space').dimensions!.height=command.height;get('edit-roof').pose.position[2]=command.height;allowed=['edit-wall','edit-space','edit-roof'];break;
 case 'raiseDeck':{if(canonical([...command.dependencies].sort())!==canonical([...deckDependencies].sort()))throw Error('unsupported-dependency-set');const delta=command.height-3;get('edit-deck').pose.position[2]+=delta;get('edit-landing').pose.position[2]+=delta;get('edit-stair').dimensions!.height+=delta;get('edit-riser').dimensions!.height+=delta;get('edit-support').dimensions!.height+=delta;s.levels.find(l=>l.id==='level/edit-deck')!.elevation=command.height;allowed=['edit-deck',...deckDependencies];break;}
 case 'move':get(command.elementId).pose.position[0]+=command.east;allowed=[command.elementId];break;
 case 'typeLength':{const t=s.types.find(t=>t.id===command.typeId);if(!t)throw Error('missing-type');t.parameters.length*=command.factor;allowed=s.elements.filter(e=>e.typeId===command.typeId).map(e=>e.id);break;}
 case 'occurrenceLength':{const e=get(command.elementId);if(!e.typeId)throw Error('variant-requires-type');e.override={...e.override,length:parameters(s,e).length+command.extra};allowed=[e.id];break;}
 }
 s.revision=`${source.revision}.${command.kind}`;s.studies=s.studies.map(v=>({...v,applicability:'stale'}));validate(s);return{candidate:s,allowedElementIds:allowed,command};
}
export function admit(base:Source,candidate:Source,expectedBaseSha:string,intended:Command,bindingsRevision=base.bindingsRevision,acceptedModelDigest=base.modelRequirement.digest){
 if(hash(sourceText(base))!==expectedBaseSha)throw Error('stale-base');validate(candidate);
 if(candidate.bindingsRevision!==bindingsRevision)throw Error('stale-binding');
 if(candidate.modelRequirement.digest!==acceptedModelDigest)throw Error('stale-operational-model');
 if(canonical(candidate.requirements)!==canonical(base.requirements))throw Error('independent-requirement-edit');
 const expected=edit(base,intended).candidate,actual=semanticDiff(base,candidate),wanted=semanticDiff(base,expected);
 if(canonical(candidate)!==canonical(expected))throw Error(`unrelated-collateral-change:${actual.filter(a=>!wanted.some(w=>w.path===a.path&&canonical(w.after)===canonical(a.after))).map(c=>c.path).join(',')}`);
 if(candidate.studies.some(st=>st.applicability!=='stale'))throw Error('stale-study-not-invalidated');
 return{source:candidate,fullDiff:actual,intendedDiff:wanted,studies:'invalidated',unrelatedChanges:[]};
}
