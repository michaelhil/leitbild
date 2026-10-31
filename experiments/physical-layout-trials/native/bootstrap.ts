import type {Source,Element,Parameters} from './model.ts';
import {sourceText,hash,elementWorld} from './model.ts';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
// Initial authoring imports the frozen brief once. build.ts never imports this module.
export async function bootstrap(out:string){
 const f=await Bun.file(new URL('../common/f1-original.json',import.meta.url)).json();
 const s:Source={schema:'leitbild-native-authoring-trial',revision:'native-r1',designId:'matched-plant-design',units:'m',axes:'Z-up',configuration:'installed',modelRequirement:{modelRef:f.plant.modelRef,digest:f.plant.modelDigest},bindingsRevision:'bindings-r1',levels:[{id:'lower',elevation:0,cutHeight:1.2},{id:'operating',elevation:15,cutHeight:1.2},{id:'edit-basement',elevation:-3,cutHeight:1.2},{id:'level/edit-deck',elevation:3,cutHeight:1.2}],types:[],elements:[],requirements:[],instances:[{id:'unit-a',siteId:'site-one',memberId:'unit-a',ownerId:'plant:trial-a',position:[0,0,0]},{id:'unit-b',siteId:'site-one',memberId:'unit-b',ownerId:'plant:trial-b',position:[160,0,0]},{id:'unit-a',siteId:'site-two',memberId:'unit-a',ownerId:'plant:trial-other',position:[0,0,0]}],imports:[],circuits:[{id:'circuit-a',fromElementId:'shared-transformer',firstSupportId:'first-support'},{id:'circuit-b',fromElementId:'shared-transformer',firstSupportId:'first-support'}],studies:[{id:'motor-removal',designRevision:'native-r1',applicability:'current'}]};
 const add=(e:Omit<Element,'disposition'|'scope'>)=>s.elements.push({...e,disposition:'installed',scope:e.levelId==='site'?'site':'unit'});
 const simple=(id:string,kind:Element['kind'],position:[number,number,number],dimensions:Parameters,levelId='lower',yaw=0)=>add({id,label:id,kind,levelId,pose:{position,yaw},dimensions});
 for(const e of f.equipment){const typeId=`type/${e.kind}`;if(!s.types.some(t=>t.id===typeId))s.types.push({id:typeId,kind:e.kind,parameters:{length:e.w/1000,width:e.h/1000,height:(e.zTop-e.zBase)/1000}});const t=s.types.find(t=>t.id===typeId)!;const dims={length:e.w/1000,width:e.h/1000,height:(e.zTop-e.zBase)/1000};
  add({id:e.id,label:e.name,kind:'equipment',levelId:e.level,pose:{position:[e.x/1000,e.y/1000,e.zBase/1000],yaw:0},typeId,equipmentKind:e.kind,spaceIds:[e.kind==='feed-pump'?'space/feedwater-room':'space/turbine-hall'],...(JSON.stringify(t.parameters)!==JSON.stringify(dims)?{override:dims}:{}),...(e.componentId?{binding:{componentId:e.componentId,relation:e.binding}}:{})});
 }
 for(const w of f.walls){const v=w.axis==='v',origin:[number,number,number]=[w.x/1000,w.y/1000,0];const h=w.id.startsWith('annex')?6.2:31.2;const id=`wall/${w.id}`;
  simple(id,'wall',origin,{length:(v?w.h:w.w)/1000,width:(v?w.w:w.h)/1000,height:h},'lower',v?Math.PI/2:0);
  for(const o of w.openings)for(const level of o.levels){const z=level==='operating'?15:0;add({id:`opening/${id}/${o.id}/${level}`,label:o.id,kind:'opening',levelId:level,hostId:id,pose:{position:[(o.start-(v?w.y:w.x))/1000,0,z+(o.kind==='glazing'?2.2:0)],yaw:0},dimensions:{length:(o.end-o.start)/1000,width:(v?w.w:w.h)/1000,height:o.kind==='shutter'?5.2:o.kind==='glazing'?3:2.7}});}
 }
 for(const d of f.doors){const dx=(d.open[0]-d.hinge[0])/1000,dy=(d.open[1]-d.hinge[1])/1000,w=Math.hypot(dx,dy);const candidates=s.elements.filter(e=>e.kind==='opening'&&e.levelId==='lower'&&e.label.startsWith(d.id.split(/[ab]$/)[0]));
  add({id:`door/${d.id}`,label:d.id,kind:'door',levelId:'lower',pose:{position:[d.hinge[0]/1000,d.hinge[1]/1000,0],yaw:Math.atan2(dy,dx)},dimensions:{length:w,width:.07,height:2.7},door:{swing:Math.PI/2},...(candidates[0]?{fillsId:candidates[0].id}:{})});
 }
 // A double-leaf door is one filling assembly; its leaves retain physical identity.
 for(const opening of s.elements.filter(e=>e.kind==='opening')){const leaves=s.elements.filter(e=>e.kind==='door'&&e.fillsId===opening.id);if(leaves.length>1){const assemblyId=`door-assembly/${opening.id}`;add({id:assemblyId,label:`${opening.label} door assembly`,kind:'assembly',levelId:opening.levelId,pose:elementWorld(s,opening),dimensions:{...opening.dimensions!},fillsId:opening.id});for(const leaf of leaves){delete leaf.fillsId;leaf.assemblyId=assemblyId;}}}
 const hall=f.hall,stairs=f.stairs;const holes=[...f.equipment.filter((e:any)=>e.kind==='condenser').map((e:any)=>({x:e.x+1300,y:e.y+3600,w:e.w-2600,h:e.h-7200})),stairs,f.hatch];
 for(const l of ['lower','operating'])add({id:`slab/${l}`,label:`${l} floor`,kind:'slab',levelId:l,pose:{position:[hall.x/1000,hall.y/1000,(l==='operating'?15:0)-.4],yaw:0},dimensions:{length:hall.w/1000,width:hall.h/1000,height:.4},holes:l==='operating'?holes.map((b:any)=>({x:(b.x-hall.x)/1000,y:(b.y-hall.y)/1000,width:b.h/1000,length:b.w/1000})):[]});
 simple('slab/annex','slab',[f.pumpRoom.x/1000,f.pumpRoom.y/1000,-.4],{length:f.pumpRoom.w/1000,width:f.pumpRoom.h/1000,height:.4});
 simple('space/turbine-hall','space',[hall.x/1000,hall.y/1000,0],{length:hall.w/1000,width:hall.h/1000,height:31.2});s.elements.at(-1)!.label='TURBINE HALL';
 simple('space/feedwater-room','space',[f.pumpRoom.x/1000,f.pumpRoom.y/1000,0],{length:f.pumpRoom.w/1000,width:f.pumpRoom.h/1000,height:6.2});s.elements.at(-1)!.label='FEEDWATER PUMP ROOM';
 simple('hatch-cover','slab',[f.hatch.x/1000,f.hatch.y/1000,14.9],{length:f.hatch.w/1000,width:f.hatch.h/1000,height:.1},'operating');
 simple('stair/main','stair',[stairs.x/1000,stairs.y/1000,0],{length:stairs.w/1000,width:stairs.h/1000,height:15});
 for(let i=0;i<9;i++)for(const y of [.4,36.4])simple(`column/${i}/${y}`,'support',[i*11,y-.4,0],{length:.8,width:.8,height:31.2});
 for(const x of [18.4,29.4,40.4,51.4])for(const y of [8,26.7])simple(`pier/${x}/${y}`,'support',[x,y,0],{length:1.2,width:1.8,height:15});
 simple('edit-wall','wall',[110,0,0],{length:12,width:.3,height:6},'lower',Math.PI/6);
 add({id:'existing-opening',label:'Existing opening',kind:'opening',levelId:'lower',hostId:'edit-wall',pose:{position:[1,0,0],yaw:0},dimensions:{length:1.2,width:.3,height:2.4}});
 simple('edit-roof','roof',[110,0,6],{length:12,width:8,height:.3},'lower',Math.PI/6);
 simple('edit-space','space',[110,0,0],{length:12,width:8,height:6},'lower',Math.PI/6);
 simple('edit-deck','slab',[110,0,2.8],{length:12,width:8,height:.2},'level/edit-deck',Math.PI/6);
 simple('edit-stair','stair',[110,2,0],{length:2.5,width:4,height:3},'lower');
 simple('edit-landing','slab',[110,5,2.8],{length:3,width:2,height:.2},'level/edit-deck');
 simple('edit-riser','riser',[120,4,0],{length:.3,width:.3,height:3},'lower');
 simple('edit-support','support',[120,2,0],{length:.3,width:.3,height:2.8},'lower');
 s.elements.find(e=>e.id==='edit-deck')!.dependsOn=['edit-stair','edit-landing','edit-riser','edit-support'];
 simple('fixed-vessel','context',[125,20,0],{length:2,width:2,height:5});
 s.requirements.push({id:'max-clear-height',targetId:'edit-wall',dimension:'height',max:9,owner:'independent-physical-brief'});
 simple('shared-yard','context',[80,-60,0],{length:25,width:20,height:.1},'site');
 simple('shared-transformer','context',[85,-55,0],{length:6,width:4,height:4},'site');
 simple('first-support','support',[100,-70,0],{length:1,width:1,height:18},'site');
 add({id:'main-steam-route',label:'Illustrative main steam route',kind:'pipe',levelId:'operating',pose:{position:[0,0,0],yaw:0},dimensions:{length:1,width:.76,height:.76},path:[[5.7,.4,23],[5.7,16.45,23],[11.15,16.45,23],[11.15,18.4,20]]});
 add({id:'feedwater-route',label:'Illustrative feedwater route',kind:'pipe',levelId:'lower',pose:{position:[0,0,0],yaw:0},dimensions:{length:1,width:.3,height:.3},path:[[21.075,43.1,1.65],[21.075,43.8,1.65],[32.9,43.8,1.65],[32.9,37.7,1.65],[42.5,37.7,1.65]]});
 await mkdir(out,{recursive:true});await Bun.write(resolve(out,'source.json'),sourceText(s));
 return s;
}
if(import.meta.main)await bootstrap(resolve(process.argv[2]??`${import.meta.dir}/output/base`));
