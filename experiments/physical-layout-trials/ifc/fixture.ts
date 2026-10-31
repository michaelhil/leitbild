import {world,clone,type Model,type Element,type Family,type V3} from './model.ts';

export async function fixture(path:string):Promise<Model>{
 const f=await Bun.file(path).json();
 const m:Model={id:'matched-ifc-site',revision:'physical-1',levels:[{id:'lower',elevation:0},{id:'operating',elevation:15},{id:'edit-cell',elevation:0}],types:[],elements:[],metadata:{modelDigest:f.plant.modelDigest,bindingDigest:'binding-1',sourceProfile:'leitbild.ifc-authoring-trial-1',studyRevision:'study-physical-1'}};
 const add=(id:string,kind:Family,levelId:string,position:V3,length:number,width:number,height:number,extra:Partial<Element>={})=>{const e:Element={id,name:id,kind,levelId,position,yaw:0,parameters:{length,width,height},disposition:'installed',...extra};m.elements.push(e);return e;};
 const families:Record<string,Family>={'feed-pump':'pump','condensate-pump':'pump','stop-valve':'valve',hp:'hp',lp:'lp',generator:'generator',exciter:'exciter',msr:'msr',condenser:'condenser'};
 for(const e of f.equipment){const family=families[e.kind]!,typeId='family-'+e.kind;
  if(!m.types.some(t=>t.id===typeId))m.types.push({id:typeId,family,parameters:{length:e.w/1000,width:e.h/1000,height:(e.zTop-e.zBase)/1000,...(family==='pump'?{serviceSide:.8}:{})}});
  add(e.id,family,e.level,[e.x/1000,e.y/1000,e.zBase/1000],1,1,1,{name:e.name,typeId,parameters:{},componentId:e.componentId,memberId:'unit-a',ownerId:'plant:trial-a'});
 }
 const spaces=[add('hall-space-lower','space','lower',[.4,.4,0],88,36,15),add('hall-space-operating','space','operating',[.4,.4,15],88,36,16.2),add('pump-space','space','lower',[8.8,37.2,0],32,16,6.2)];
 for(const w of f.walls)for(const level of w.levels){const v=w.axis==='v',z=level==='operating'?15:0,wall=add(w.id+'/'+level,'wall',level,[w.x/1000+(v?w.w/1000:0),w.y/1000,z],(v?w.h:w.w)/1000,(v?w.w:w.h)/1000,w.id.startsWith('annex')?6.2:level==='operating'?16.2:15,{yaw:v?Math.PI/2:0});
  for(const o of w.openings.filter((o:any)=>o.levels.includes(level))){const distance=(o.start-(v?w.y:w.x))/1000,height=o.kind==='glazing'?3:o.kind==='shutter'?5.2:2.7,opening=add(o.id+'/'+w.id+'/'+level,'opening',level,world(wall,[distance,-.01,o.kind==='glazing'?2.2:0]),(o.end-o.start)/1000,wall.parameters.width as number+.02,height,{yaw:wall.yaw,hostId:wall.id,spaceIds:wall.id.startsWith('annex')?['pump-space','hall-space-lower']:['hall-space-'+level]});
   if(o.kind!=='glazing')add(opening.id+'/door','door',level,opening.position,(o.end-o.start)/1000,.06,height,{yaw:wall.yaw,fillsId:opening.id,spaceIds:opening.spaceIds});
  }
 }
 add('floor-lower','slab','lower',[.4,.4,-.45],88,36,.45);const floor=add('floor-operating','slab','operating',[.4,.4,14.6],88,36,.4);add('floor-annex','slab','lower',[8.8,37.2,-.45],32,16,.45);
 const holes=[f.stairs,f.hatch,...f.equipment.filter((e:any)=>e.kind==='condenser').map((e:any)=>({x:e.x+1300,y:e.y+3600,w:e.w-2600,h:e.h-7200}))];
 for(const [i,q] of holes.entries())add('deck-opening-'+i,'opening','operating',[q.x/1000,q.y/1000,14.5],q.w/1000,q.h/1000,.6,{hostId:floor.id});
 add('stair-s1','stair','lower',[f.stairs.x/1000,f.stairs.y/1000,0],f.stairs.w/1000,f.stairs.h/1000,15);
 for(let i=0;i<9;i++)for(const y of [0,36])add(`column-${i}-${y}`,'support','lower',[i*11,y,0],.8,.8,31);
 add('hall-roof','roof','operating',[0,0,31.2],88.8,36.8,.25);add('pump-roof','roof','lower',[8.4,36.8,6.2],32.8,16.8,.2);
 const pipe=(id:string,level:string,path:V3[],radius:number)=>add(id,'pipe',level,[0,0,0],1,1,1,{parameters:{length:1,width:1,height:1,path:JSON.stringify(path),radius}});
 pipe('main-steam-route','operating',[[5.7,.4,23],[5.7,16.45,23],[11.15,16.45,23],[11.15,18.4,20]],.38);
 pipe('feedwater-route','lower',[[8.8,39.9,1.65],[15.1,39.9,1.65],[15.1,40.5,1.65],[18.2,40.5,1.65]],.18);
 pipe('cable-riser-route','lower',[[82,30,1],[82,30,15],[82,20,15]],.12);
 // F2: a separate rotated editing cell. Native placements own every datum.
 add('edit-space-a','space','edit-cell',[110,0,0],12,6,6,{yaw:Math.PI/6});add('edit-space-b','space','edit-cell',[110,-6,0],12,6,6,{yaw:Math.PI/6});
 const wall=add('edit-wall','wall','edit-cell',[110,0,0],12,.3,6,{yaw:Math.PI/6});
 const opening=add('existing-opening','opening','edit-cell',world(wall,[1,-.01,0]),1.2,.32,2.4,{yaw:wall.yaw,hostId:wall.id,spaceIds:['edit-space-a','edit-space-b']});
 add('existing-door','door','edit-cell',opening.position,1.2,.06,2.4,{yaw:wall.yaw,fillsId:opening.id,spaceIds:opening.spaceIds});
 add('edit-roof','roof','edit-cell',[110,0,6],12,6,.2,{yaw:wall.yaw});add('edit-deck','slab','edit-cell',[110,0,2.8],12,6,.2,{yaw:wall.yaw});
 add('edit-stair','stair','edit-cell',[110,0,0],3,6,3,{yaw:wall.yaw});add('edit-landing','slab','edit-cell',[110,5,2.8],3,1,.2,{yaw:wall.yaw});add('edit-riser','riser','edit-cell',[119,0,0],.3,.3,3);add('edit-support','support','edit-cell',[120,0,0],.4,.4,2.8);
 add('fixed-vessel','vessel','edit-cell',[125,20,0],4,4,10);
 return m;
}

export function compose(source:Model):Model{
 const m=clone(source);m.id='composed-site';m.revision='composed-1';m.elements=[];
 for(const [memberId,x] of [['unit-a',0],['unit-b',160]] as const)for(const original of source.elements.filter(e=>!e.id.startsWith('edit-')&&!['existing-opening','existing-door','fixed-vessel'].includes(e.id))){const e=clone(original);e.id=memberId+'/'+original.id;e.position[0]+=x;e.memberId=memberId;if(e.componentId)e.ownerId=memberId==='unit-a'?'plant:trial-a':'plant:trial-b';if(e.hostId)e.hostId=memberId+'/'+e.hostId;if(e.fillsId)e.fillsId=memberId+'/'+e.fillsId;if(e.spaceIds)e.spaceIds=e.spaceIds.map(id=>memberId+'/'+id);m.elements.push(e);}
 for(const [id,kind,pos,w,d,h] of [['shared-yard','slab',[80,-60,0],32,18,.3],['shared-transformer','transformer',[85,-55,.3],6,4,5],['first-support','pylon',[100,-50,0],3,3,18]] as const)m.elements.push({id,name:id,kind,levelId:'site',position:[...pos],yaw:0,parameters:{length:w,width:d,height:h,...(id==='first-support'?{circuits:'circuit-a|circuit-b'}:{})},disposition:'installed'} as Element);
 return m;
}
