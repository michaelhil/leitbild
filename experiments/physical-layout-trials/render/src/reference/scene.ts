import {plant,equipment,hall,pumpRoom,stairs,hallColumns,tablePiers,hatch,crane,walls,wallSpans,routes,laydown,withdrawal,assemblyBounds,pumpNozzles,type Level,type Box,type Equipment} from './model';
import {Mesh,palette as p,type Color} from './mesh';
import {dot,sub,type V3,type Bounds} from './math';
export {plant,equipment,assemblyBounds};
export type Mode='all'|'operating'|'lower';
export type SceneObject={id:string;name:string;level:Level|'link';kind:'equipment'|'floor'|'wall'|'structure'|'utilities'|'service'|'crane'|'context';mesh:Mesh;lowMesh?:Mesh;side?:V3;equipmentId?:string;componentId?:string|undefined;opacity?:number};
export type ViewState={mode:Mode;walls:'cutaway'|'full'|'hidden';utilities:boolean;service:boolean;crane:boolean;explode:number};
export type DrawObject={object:SceneObject;mesh:Mesh;offset:number};
export const shaftElevation=17.2;
export const stairDesign={flights:6,risersPerFlight:16,risePerFlight:2.5,going:.275,flightWidth:2,totalRise:15} as const;
const m=(n:number)=>n/1000;
export const slabHoles:Box[]=[...equipment.filter(e=>e.kind==='condenser').map(e=>({x:e.x+1300,y:e.y+3600,w:e.w-2600,h:e.h-7200})),stairs,hatch];
// Rectangular decomposition, not a CSG kernel: only the finite source floorplate and five openings.
export function slabCells(plate:Box,holes:Box[]):Box[]{const xs=[plate.x,plate.x+plate.w,...holes.flatMap(b=>[b.x,b.x+b.w])].filter(x=>x>=plate.x&&x<=plate.x+plate.w).sort((a,b)=>a-b),zs=[plate.y,plate.y+plate.h,...holes.flatMap(b=>[b.y,b.y+b.h])].filter(z=>z>=plate.y&&z<=plate.y+plate.h).sort((a,b)=>a-b),cells:Box[]=[];
 for(let i=0;i<xs.length-1;i++)for(let j=0;j<zs.length-1;j++){const x=xs[i]!,z=zs[j]!,w=xs[i+1]!-x,h=zs[j+1]!-z;if(w<=0||h<=0)continue;const cx=x+w/2,cz=z+h/2;if(!holes.some(b=>cx>b.x&&cx<b.x+b.w&&cz>b.y&&cz<b.y+b.h))cells.push({x,y:z,w,h});}return cells;
}
function bolt(mesh:Mesh,x:number,y:number,z:number){mesh.cylinder([x,y,z],[x,y+.12,z],.095,p.dark,6);}
function plinth(mesh:Mesh,e:Equipment){const b=assemblyBounds(e);mesh.box(m(b.x),m(e.zBase),m(b.y),m(b.w),.3,m(b.h),p.plinth);}
function motor(mesh:Mesh,x:number,y:number,z:number,w:number,h:number,d:number){
 mesh.loftX(x,y,z,[[0,h*.7,d*.7],[.35,h,d],[w-.45,h,d],[w,h*.78,d*.78]],p.motor);
 for(let xx=.5;xx<w-.4;xx+=.35)mesh.loftX(x,y,z,[[xx,h+.07,d+.07],[xx+.065,h+.07,d+.07]],p.light,24);
 mesh.box(x+w-.9,y+h*.72,z-.4,.7,.5,.8,p.dark);
 mesh.box(x+.4,y-h-.2,z-d*.65,w-.8,.3,d*1.3,p.dark);
}
function equipmentMesh(e:Equipment):Mesh{
 const mesh=new Mesh(),x=m(e.x),z=m(e.y),w=m(e.w),d=m(e.h),base=m(e.zBase),top=m(e.zTop),cy=shaftElevation,cz=z+d/2;
 switch(e.kind){
 case 'hp':{
  plinth(mesh,e);mesh.box(x+.8,base+.3,z+.6,w-1.6,1.2,d-1.2,p.dark);
  mesh.loftX(x,cy,cz,[[.1,1.05,1.35],[1.1,1.55,2.05],[w/2,1.65,2.25],[w-1.1,1.55,2.05],[w-.1,1.05,1.35]],p.machine);
  mesh.box(x+.5,cy-.14,z+.05,w-1,.25,d-.1,p.hood);
  for(let xx=1;xx<w-.5;xx+=.7){mesh.loftX(x,cy,cz,[[xx,1.69,2.28],[xx+.09,1.69,2.28]],p.light,24);bolt(mesh,x+xx,cy+.14,z+.22);bolt(mesh,x+xx,cy+.14,z+d-.22);}
  break;}
 case 'lp':{
  const bounds=assemblyBounds(e),neck=slabHoles.find(b=>b.x===e.x+1300)!;for(const b of slabCells(bounds,[neck]))mesh.box(m(b.x),base,m(b.y),m(b.w),.3,m(b.h),p.plinth);
  mesh.frustum(x+.1,base+.3,z+.1,w-.2,d-.2,2.8,w-1.4,d-1.4,p.hood);
  mesh.loftX(x,cy,cz,[[.1,1.5,3.4],[.9,1.9,4.7],[w/2,2.0,5.05],[w-.9,1.9,4.7],[w-.1,1.5,3.4]],p.machine,40);
  mesh.box(x+.15,cy-.18,z+.1,w-.3,.32,d-.2,p.light);
  for(let xx=.65;xx<w-.4;xx+=.85)for(const zz of[z+.25,z+d-.25])bolt(mesh,x+xx,cy+.15,zz);
  for(let zz=1;zz<d-.5;zz+=1)for(const xx of[x+.25,x+w-.25])bolt(mesh,xx,cy+.15,z+zz);
  mesh.loftX(x,cy,cz,[[w/2-.12,2.06,5.12],[w/2+.12,2.06,5.12]],p.light,40);break;}
 case 'generator':{
  plinth(mesh,e);mesh.box(x+.7,base+.3,z+.4,w-1.4,.5,d-.8,p.dark);
  mesh.loftX(x,cy,cz,[[.1,1.6,2.1],[1.0,2.05,2.8],[w-1,2.05,2.8],[w-.1,1.6,2.1]],p.motor,40);
  for(let xx=1.5;xx<w-1.1;xx+=.65)mesh.loftX(x,cy,cz,[[xx,2.1,2.9],[xx+.07,2.1,2.9]],p.light,32);
  mesh.box(x+w*.42,base+.4,z+d-.5,3,1.8,1.3,p.light);
  for(let i=0;i<3;i++)mesh.cylinder([x+w*.45+.35+i*.75,base+.8,z+d+.8],[x+w*.45+.35+i*.75,base+.8,z+d+1.6],.22,p.crane,12);break;}
 case 'exciter':plinth(mesh,e);motor(mesh,x,cy,cz,w,1.35,1.35);break;
 case 'msr':{
  mesh.box(x+1,base,z+.2,w-2,.4,d-.4,p.plinth);for(const xx of[x+1.4,x+w-1.6])mesh.box(xx,base+.4,z+.5,.3,1.2,d-1,p.dark);
  mesh.loftX(x,base+2.6,cz,[[0,.05,.05],[.35,1.1,1.1],[1,1.4,1.4],[w-1,1.4,1.4],[w-.35,1.1,1.1],[w,.05,.05]],p.hood,32);
  for(const xx of[1.1,w-1.1])mesh.loftX(x,base+2.6,cz,[[xx,1.44,1.44],[xx+.08,1.44,1.44]],p.light);
  mesh.cylinder([x+w-1.9,base+2.6,z],[x+w-1.9,base+2.6,z-.5],.3,p.dark);mesh.cylinder([x+1.8,base+2.6,z+d],[x+1.8,base+2.6,z+d+.5],.25,p.dark);break;}
 case 'stop-valve':{
  mesh.box(x+.25,base,z+.35,w-.5,.4,d-.7,p.plinth);mesh.cylinder([x,base+1.3,cz],[x+w,base+1.3,cz],.4,p.machine);mesh.frustum(x+.35,base+.6,cz-.65,1.1,1.3,1.1,.6,.7,p.machine);mesh.cylinder([x+w/2,base+1.4,cz],[x+w/2,base+2.7,cz],.09,p.dark);mesh.cylinder([x+w/2,base+2.7,cz],[x+w/2,base+2.85,cz],.42,p.crane,20);break;}
 case 'condenser':{
  mesh.box(x,base,z,w,.4,d,p.plinth);mesh.box(x+.25,base+.4,z+1.8,w-.5,11.3,d-3.6,p.machine);
  mesh.frustum(x+.5,base+11.7,z+2.0,w-1,d-4,2.9,w-2.6,d-7.2,p.hood);
  for(const zz of[z+.15,z+d-1.55]){mesh.box(x+.4,base+.7,zz,w-.8,10.4,1.4,p.waterbox);for(const xx of[x+w*.3,x+w*.7]){mesh.cylinder([xx,base+5.9,zz-.05],[xx,base+5.9,zz+1.45],.85,p.light,24);mesh.cylinder([xx,base+5.9,zz-.1],[xx,base+5.9,zz-.05],.62,p.dark);}}
  for(let yy=2;yy<11;yy+=2.2)for(const xx of[x+.18,x+w-.28])mesh.box(xx,base+yy,z+1.8,.1,.16,d-3.6,p.light);
  mesh.box(x+w-1.7,base+.5,z+d*.45,2.4,4,2.4,p.waterbox);break;}
 case 'feed-pump':case 'condensate-pump':{
  plinth(mesh,e);const big=e.kind==='feed-pump',py=base+(big?1.65:1.4),core=big?4.6:2.15,r=big?.95:.85;
  mesh.loftX(x+.15,py,cz,[[0,r*.7,r*.7],[.3,r,r],[core-.3,r,r],[core,r*.7,r*.7]],p.machine,28);
  if(big)for(let xx=.8;xx<4.4;xx+=.46)mesh.loftX(x,py,cz,[[xx,1.02,1.02],[xx+.08,1.02,1.02]],p.light,24);
  const mx=big?6.5:2.95,mw=big?5.2:2.15;motor(mesh,x+mx,py,cz,mw,big?1.1:.75,big?1.1:.75);
  mesh.cylinder([x+core,py,cz],[x+mx,py,cz],.18,p.dark,16);mesh.box(x+core+.1,py-.36,cz-.37,mx-core-.2,.72,.74,p.crane);
  const nozzles=pumpNozzles(e);for(const [key,point] of Object.entries(nozzles)){const px=m(point[0]),pz=m(point[1]),bodyZ=key==='inlet'?cz-.65:cz+.65;if(!big&&key==='inlet'){mesh.cylinder([px,py,pz],[px+.5,py,pz],.26,p.machine,16);mesh.cylinder([px,py,pz],[px+.12,py,pz],.36,p.light,20);}else{mesh.cylinder([px,py,bodyZ],[px,py,pz],.26,p.machine,16);mesh.cylinder([px,py,pz-.06],[px,py,pz+.06],.36,p.light,20);}}
  break;}
 }
 // The source elevations bound every equipment solid; extra routing is a separate overlay.
 if(top<=base)throw Error(`Invalid source height ${e.id}`);return mesh;
}
function wallMesh(w:typeof walls[number],level:Level,low=false){const mesh=new Mesh(),annex=w.id.startsWith('annex'),base=level==='operating'?15:0,height=low?1.1:annex?6.2:level==='operating'?16.2:15;
 const b=(box:Box,y:number,h:number)=>mesh.box(m(box.x),y,m(box.y),m(box.w),h,m(box.h),p.wall);
 for(const span of wallSpans(w,level))b(span,base,height);
 for(const o of w.openings.filter(o=>o.levels.includes(level))){const gap=w.axis==='h'?{x:o.start,y:w.y,w:o.end-o.start,h:w.h}:{x:w.x,y:o.start,w:w.w,h:o.end-o.start};
  if(o.kind==='glazing'){const sill=2.2,head=5.2;if(!low){b(gap,base,sill);b(gap,base+head,height-head);for(let xx=o.start;xx<=o.end;xx+=1400)mesh.box(m(xx)-.035,base+sill,m(w.y)+.12,.07,head-sill,.16,p.steel);mesh.box(m(o.start),base+sill,m(w.y)+.1,m(o.end-o.start),.08,.2,p.steel);mesh.box(m(o.start),base+head-.08,m(w.y)+.1,m(o.end-o.start),.08,.2,p.steel);}else b(gap,base,height);
  }else{const openingHeight=o.kind==='shutter'?5.2:2.7;if(height>openingHeight)b(gap,base+openingHeight,height-openingHeight);}
 }return mesh;
}
function stairMesh(){const mesh=new Mesh(),x=m(stairs.x),z=m(stairs.y),start=z+5.9,end=z+1.5,steps=stairDesign.risersPerFlight,rise=stairDesign.risePerFlight/steps,run=(start-end)/steps;
 for(let flight=0;flight<stairDesign.flights;flight++){const left=flight%2===0,fx=x+(left?.2:3),base=flight*stairDesign.risePerFlight;
  for(let i=0;i<steps;i++){const zz=left?start-(i+1)*run:end+i*run;mesh.box(fx,base+i*rise,zz,2,rise,run,p.light,false);}
  for(const xx of[fx+.1,fx+1.9]){const a:V3=[xx,base+.06,left?start:end],b:V3=[xx,base+2.56,left?end:start];mesh.cylinder(a,b,.06,p.steel,8);mesh.cylinder([a[0],a[1]+1.05,a[2]],[b[0],b[1]+1.05,b[2]],.035,p.crane,8);for(let i=0;i<=steps;i+=4){const yy=base+i*rise,zz=left?start-i*run:end+i*run;mesh.cylinder([xx,yy,zz],[xx,yy+1.1,zz],.025,p.crane,6);}}
  const landingZ=left?z+.2:z+5.9;mesh.box(x+.2,base+2.38,landingZ,4.8,.12,left?1.3:1.5,p.light);
 }
 mesh.box(x+.2,-.12,z+5.9,4.8,.12,1.3,p.light);return mesh;
}
function rail(mesh:Mesh,a:V3,b:V3){mesh.cylinder([a[0],a[1]+1.1,a[2]],[b[0],b[1]+1.1,b[2]],.035,p.crane,8);const len=Math.hypot(b[0]-a[0],b[2]-a[2]),n=Math.ceil(len/1.6);for(let i=0;i<=n;i++){const t=i/n,x=a[0]+(b[0]-a[0])*t,z=a[2]+(b[2]-a[2])*t;mesh.cylinder([x,a[1],z],[x,a[1]+1.1,z],.025,p.crane,6);}}
export function buildScene():SceneObject[]{const out:SceneObject[]=[];
 const put=(id:string,name:string,level:SceneObject['level'],kind:SceneObject['kind'],mesh:Mesh,extra:Partial<SceneObject>={})=>out.push({id,name,level,kind,mesh,...extra});
 const ground=new Mesh();ground.plane(-12,-.62,-12,114,82,p.ground);for(let x=-10;x<=100;x+=10)ground.line([x,-.61,-10],[x,-.61,70]);for(let z=-10;z<=70;z+=10)ground.line([-10,-.61,z],[100,-.61,z]);put('ground','Site reference grid','lower','context',ground);
 for(const level of['lower','operating'] as const){const floor=new Mesh(),y=level==='operating'?15:0,thickness=level==='operating'?.4:.45;for(const b of slabCells(hall,level==='operating'?slabHoles:[]))floor.box(m(b.x),y-thickness,m(b.y),m(b.w),thickness,m(b.h),p.floor,false);put(`floor-${level}`,`${level} floor slab`,level,'floor',floor);
  if(level==='lower'){const annex=new Mesh();annex.box(m(pumpRoom.x),-.45,m(pumpRoom.y),m(pumpRoom.w),.45,m(pumpRoom.h),p.floor);put('floor-annex','Pump room floor','lower','floor',annex);}
  for(const w of walls.filter(w=>w.levels.includes(level))){const side:V3=w.id.endsWith('north')?[0,0,-1]:w.id.endsWith('south')?[0,0,1]:w.id.endsWith('west')?[-1,0,0]:[1,0,0];put(`${w.id}-${level}`,w.id,level,'wall',wallMesh(w,level),{lowMesh:wallMesh(w,level,true),side});}
  const frame=new Mesh();for(const b of hallColumns){const x=m(b.x),z=m(b.y),height=level==='lower'?15:16.6;frame.box(x,y,z,.8,height,.12,p.steel);frame.box(x,y,z+.68,.8,height,.12,p.steel);frame.box(x+.34,y,z+.12,.12,height,.56,p.steel);frame.box(x-.1,y,z-.1,1,.16,1,p.dark);}
  if(level==='lower')for(const b of tablePiers)frame.box(m(b.x),0,m(b.y),m(b.w),15,m(b.h),p.plinth);
  put(`frame-${level}`,'Structural columns and turbine-table supports',level,'structure',frame);
 }
 const hatchMesh=new Mesh();hatchMesh.box(m(hatch.x),14.9,m(hatch.y),m(hatch.w),.1,m(hatch.h),p.light);for(let i=1;i<4;i++)hatchMesh.line([m(hatch.x)+i*2,15.01,m(hatch.y)],[m(hatch.x)+i*2,15.01,m(hatch.y+hatch.h)]);put('hatch-cover','Removable equipment hatch, closed','operating','structure',hatchMesh);
 const stair=stairMesh();put('stair-s1','Stair S1, six flights with intermediate landings','lower','structure',stair);
 const guards=new Mesh();rail(guards,[m(stairs.x),15,m(stairs.y)],[m(stairs.x+stairs.w),15,m(stairs.y)]);rail(guards,[m(stairs.x),15,m(stairs.y)],[m(stairs.x),15,m(stairs.y+stairs.h)]);rail(guards,[m(stairs.x+stairs.w),15,m(stairs.y)],[m(stairs.x+stairs.w),15,m(stairs.y+stairs.h)]);put('stair-guard','Upper stair opening guardrails','operating','structure',guards);
 for(const e of equipment)put(e.id,e.name,e.level,'equipment',equipmentMesh(e),{equipmentId:e.id,componentId:e.componentId});
 const shaft=new Mesh();shaft.cylinder([8.3,shaftElevation,18.4],[75.7,shaftElevation,18.4],.23,p.dark,16);for(const x of[8.6,18.4,30,41,52.6,69,75.7]){shaft.box(x-.6,15,17.5,1.2,.35,1.8,p.plinth);shaft.box(x-.4,15.35,17.8,.8,1.5,1.2,p.dark);shaft.cylinder([x-.4,shaftElevation,18.4],[x+.4,shaftElevation,18.4],.65,p.light,20);}put('shaftline','Turbine-generator shared shaft and bearings','operating','structure',shaft,{componentId:'turbine'});
 const necks=new Mesh();for(const e of equipment.filter(e=>e.kind==='condenser'))necks.box(m(e.x+1300),14.6,m(e.y+3600),m(e.w-2600),1.1,m(e.h-7200),p.hood);put('exhaust-transitions','LP exhaust transitions through deck openings','link','structure',necks,{componentId:'turbine'});
 for(const [i,z] of crane.runways.map(m).entries()){const runway=new Mesh();runway.box(.4,27.5,z-.16,88,.8,.32,p.steel);runway.box(.4,28.3,z-.07,88,.1,.14,p.dark);put(`crane-runway-${i}`,'Crane runway; foreground runway removed with cutaway','operating','crane',runway,{side:[0,0,i===0?-1:1]});}
 const gantry=new Mesh();for(const x of[80,81.1])gantry.box(x,28.4,2.5,.3,1.1,31.7,p.crane);gantry.box(79.7,29.5,17,2.2,.8,2.8,p.dark);gantry.cylinder([80.7,29.5,18.4],[80.7,24,18.4],.045,p.dark,8);gantry.cylinder([80.7,24,18.4],[80.7,23.4,18.4],.18,p.crane,16);put('crane','Overhead bridge crane, schematic','operating','crane',gantry);
 for(const level of['lower','operating'] as const){const service=new Mesh(),y=level==='lower'?.03:15.03;for(const b of routes[level])service.plane(m(b.x),y,m(b.y),m(b.w),m(b.h),p.access);const bays=level==='operating'?[laydown,withdrawal]:[{x:31200,y:39700,w:8500,h:4200}];for(const b of bays){service.plane(m(b.x),y+.01,m(b.y),m(b.w),m(b.h),p.outage);for(let x=m(b.x);x<m(b.x+b.w);x+=.8)service.line([x,y+.02,m(b.y)],[Math.min(x+.8,m(b.x+b.w)),y+.02,m(b.y+b.h)]);}put(`service-${level}`,'Conceptual outage and access allowances',level,'service',service,{opacity:.42});}
 // Optional finite routing studies follow the same plan positions as the 2D trial.
 for(const level of['lower','operating'] as const){const pipes=new Mesh();const route=(points:V3[],r:number,c:Color)=>{for(let i=0;i<points.length-1;i++)pipes.cylinder(points[i]!,points[i+1]!,r,c,12);};
  if(level==='lower'){
   for(const e of equipment.filter(e=>e.kind==='feed-pump')){const q=pumpNozzles(e),z=m(q.inlet[1]),zz=m(q.outlet[1]);route([[8.8,1.65,39.9],[15.1,1.65,39.9],[15.1,1.65,z-.7],[m(q.inlet[0]),1.65,z-.7],[m(q.inlet[0]),1.65,z]],.18,p.pipe);route([[m(q.outlet[0]),1.65,zz],[m(q.outlet[0]),1.65,zz+.7],[32.9,1.65,zz+.7],[32.9,1.65,37.7],[42.5,1.65,37.7]],.15,p.machine);}
   for(const e of equipment.filter(e=>e.kind==='condensate-pump')){const q=pumpNozzles(e);route([[51.7,1.4,18.8],[54,1.4,18.8],[54,1.4,m(q.inlet[1])],[m(q.inlet[0]),1.4,m(q.inlet[1])]],.16,p.pipe);route([[m(q.outlet[0]),1.4,m(q.outlet[1])],[m(q.outlet[0]),1.4,6.8],[73.5,1.4,6.8],[73.5,1.4,.4]],.16,p.pipe);}
  }else{
   route([[5.7,23,.4],[5.7,23,16.45],[11.15,23,16.45],[11.15,20,18.4]],.38,p.steam);
   for(const z of[10.4,26.6]){route([[15.7,23,z],[46.5,23,z]],.42,p.steam);for(const x of[24.5,35.5,46.5])route([[x,23,z],[x,23,z<18.4?12.8:24],[x,19.6,z<18.4?12.8:24]],.32,p.steam);}
  }put(`pipes-${level}`,'Illustrative utility routes; supports and interference unresolved',level,'utilities',pipes);
 }
 return out;
}
export function drawObjects(scene:SceneObject[],state:ViewState,eye:V3):DrawObject[]{return scene.flatMap(object=>{
 if(object.level==='link'&&(state.mode!=='all'||state.explode>0))return[];
 if(object.level!=='link'&&state.mode!=='all'&&object.level!==state.mode)return[];
 if(object.kind==='utilities'&&!state.utilities||object.kind==='service'&&!state.service||object.kind==='crane'&&!state.crane)return[];
 if(object.kind==='wall'&&state.walls==='hidden')return[];
 const near=object.side&&dot(sub(eye,[44.4,0,26.8]),object.side)>0;
 if(object.kind==='crane'&&object.side&&state.walls==='cutaway'&&near)return[];
 return[{object,mesh:object.kind==='wall'&&state.walls==='cutaway'&&near?object.lowMesh!:object.mesh,offset:state.mode==='all'&&object.level==='operating'?state.explode:0}];
 });}
export function sceneManifest(scene:SceneObject[],sourceSha256:string){return {plant,source:{path:'../pwr-turbine-hall-browser-trial/src/model.ts',sha256:sourceSha256},units:'metres',axes:{x:'source plan X',y:'source elevation',z:'source plan Y'},geometryStatus:'illustrative 3D extension of the authored 2D study',shaftElevation,stairDesign,slabHoles,objects:scene.map(o=>({id:o.id,name:o.name,level:o.level,kind:o.kind,equipmentId:o.equipmentId,componentId:o.componentId,binding:o.equipmentId?equipment.find(e=>e.id===o.equipmentId)!.binding:undefined,bounds:o.mesh.bounds,vertices:o.mesh.vertices.length/9,triangles:o.mesh.vertices.length/27}))};}
export function movedBounds(b:Bounds,offset:number):Bounds{return {min:[b.min[0],b.min[1]+offset,b.min[2]],max:[b.max[0],b.max[1]+offset,b.max[2]]};}
