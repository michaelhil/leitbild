import { createHash } from 'node:crypto';

export type V3 = [number, number, number];
export type Family = 'pump'|'hp'|'lp'|'generator'|'exciter'|'msr'|'valve'|'condenser'|'wall'|'slab'|'opening'|'door'|'stair'|'roof'|'riser'|'support'|'vessel'|'transformer'|'pylon'|'pipe'|'space';
export type Params = Record<string,number|string>;
export type Element = {id:string;name:string;kind:Family;typeId?:string;levelId:string;position:V3;yaw:number;parameters:Params;componentId?:string;memberId?:string;ownerId?:string;hostId?:string;fillsId?:string;spaceIds?:string[];disposition:'installed'|'proposed'|'removed'|'temporary'};
export type PhysicalType={id:string;family:Family;parameters:Params};
export type Model={id:string;revision:string;levels:{id:string;elevation:number}[];types:PhysicalType[];elements:Element[];metadata:{modelDigest:string;bindingDigest:string;sourceProfile:string;studyRevision:string}};
export type Mesh={positions:number[];indices:number[]};
export const hash=(value:unknown)=>createHash('sha256').update(value instanceof Uint8Array?value:typeof value==='string'?value:JSON.stringify(value)??'undefined').digest('hex');
export const clone=<T>(value:T):T=>structuredClone(value);
export const guid=(id:string)=>{let n=BigInt('0x'+hash(id).slice(0,32)),s='';const a='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';for(let i=0;i<22;i++){s=a[Number(n%64n)]+s;n/=64n;}return s;};
export const parameters=(model:Model,e:Element):Params=>({...model.types.find(t=>t.id===e.typeId)?.parameters,...e.parameters});
export const rotate=(p:V3,yaw:number):V3=>[p[0]*Math.cos(yaw)-p[1]*Math.sin(yaw),p[0]*Math.sin(yaw)+p[1]*Math.cos(yaw),p[2]];
export const world=(e:Element,p:V3):V3=>{const q=rotate(p,e.yaw);return q.map((v,i)=>v+e.position[i]!) as V3;};
export const local=(e:Element,p:V3):V3=>rotate(p.map((v,i)=>v-e.position[i]!) as V3,-e.yaw);
export const number=(p:Params,k:string)=>{const v=p[k];if(typeof v!=='number'||!Number.isFinite(v))throw Error(`INVALID_PARAMETER:${k}`);return v;};
export function bounds(mesh:Mesh){return [0,1,2,0,1,2].map((axis,i)=>{let n=i<3?Infinity:-Infinity;for(let j=axis;j<mesh.positions.length;j+=3)n=i<3?Math.min(n,mesh.positions[j]!):Math.max(n,mesh.positions[j]!);return n;});}
export function merge(mesh:Mesh,other:Mesh){const o=mesh.positions.length/3;mesh.positions.push(...other.positions);mesh.indices.push(...other.indices.map(i=>i+o));}
export function box(x:number,y:number,z:number,w:number,d:number,h:number):Mesh{
 const positions=[x,y,z,x+w,y,z,x+w,y+d,z,x,y+d,z,x,y,z+h,x+w,y,z+h,x+w,y+d,z+h,x,y+d,z+h];
 return {positions,indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]};
}
export function loftX(stations:[number,number,number][],cy:number,cz:number,segments=24):Mesh{
 const positions:number[]=[],indices:number[]=[];
 for(const [x,ry,rz] of stations)for(let i=0;i<segments;i++){const a=i*Math.PI*2/segments;positions.push(x,cy+ry*Math.cos(a),cz+rz*Math.sin(a));}
 for(let j=0;j<stations.length-1;j++)for(let i=0;i<segments;i++){const a=j*segments+i,b=j*segments+(i+1)%segments,c=b+segments,d=a+segments;indices.push(a,b,c,a,c,d);}
 const first=positions.length/3;positions.push(stations[0]![0],cy,cz,stations.at(-1)![0],cy,cz);
 for(let i=0;i<segments;i++){indices.push(first,(i+1)%segments,i);const a=(stations.length-1)*segments;indices.push(first+1,a+i,a+(i+1)%segments);}
 return {positions,indices};
}
export function cylinder(a:V3,b:V3,r:number,segments=16):Mesh{
 const delta=b.map((v,i)=>v-a[i]!) as V3,len=Math.hypot(...delta);if(len<1e-8)throw Error('ZERO_CYLINDER');
 const w=delta.map(v=>v/len) as V3,t=Math.abs(w[2])>.9?[1,0,0]:[0,0,1];
 let u=[w[1]*t[2]!-w[2]*t[1]!,w[2]*t[0]!-w[0]*t[2]!,w[0]*t[1]!-w[1]*t[0]!] as V3;const ul=Math.hypot(...u);u=u.map(v=>v/ul) as V3;
 const v=[w[1]*u[2]-w[2]*u[1],w[2]*u[0]-w[0]*u[2],w[0]*u[1]-w[1]*u[0]];
 const positions:number[]=[],indices:number[]=[];
 for(const q of [a,b])for(let i=0;i<segments;i++){const angle=i*Math.PI*2/segments;positions.push(...q.map((n,j)=>n+r*(u[j]!*Math.cos(angle)+v[j]!*Math.sin(angle))));}
 for(let i=0;i<segments;i++){const j=(i+1)%segments;indices.push(i,j,j+segments,i,j+segments,i+segments);}
 positions.push(...a,...b);for(let i=0;i<segments;i++){const j=(i+1)%segments;indices.push(2*segments,j,i,2*segments+1,i+segments,j+segments);}return {positions,indices};
}
const rectCells=(w:number,d:number,holes:{x:number;y:number;w:number;d:number}[])=>{
 const xs=[0,w,...holes.flatMap(h=>[h.x,h.x+h.w])].filter(v=>v>=0&&v<=w).sort((a,b)=>a-b),ys=[0,d,...holes.flatMap(h=>[h.y,h.y+h.d])].filter(v=>v>=0&&v<=d).sort((a,b)=>a-b),cells:{x:number;y:number;w:number;d:number}[]=[];
 for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++){const x=xs[i]!,y=ys[j]!,cw=xs[i+1]!-x,cd=ys[j+1]!-y;if(cw>1e-9&&cd>1e-9&&!holes.some(h=>x+cw/2>h.x&&x+cw/2<h.x+h.w&&y+cd/2>h.y&&y+cd/2<h.y+h.d))cells.push({x,y,w:cw,d:cd});}return cells;
};
export function body(model:Model,e:Element):Mesh{
 const p=parameters(model,e),w=number(p,'length'),d=number(p,'width'),h=number(p,'height'),mesh:Mesh={positions:[],indices:[]};
 const add=(m:Mesh)=>merge(mesh,m),b=(x:number,y:number,z:number,l:number,ww:number,hh:number)=>add(box(x,y,z,l,ww,hh));
 const openings=model.elements.filter(o=>o.hostId===e.id&&o.kind==='opening').map(o=>{const q=local(e,o.position),s=parameters(model,o);return {x:q[0],y:q[1],z:q[2],w:number(s,'length'),d:number(s,'width'),h:number(s,'height')};});
 if(e.kind==='wall'){
  let at=0;for(const o of openings.sort((a,b)=>a.x-b.x)){if(o.x>at)b(at,0,0,o.x-at,d,h);if(o.z>0)b(o.x,0,0,o.w,d,o.z);if(o.z+o.h<h)b(o.x,0,o.z+o.h,o.w,d,h-o.z-o.h);at=o.x+o.w;}if(at<w)b(at,0,0,w-at,d,h);
 }else if(e.kind==='slab'||e.kind==='roof')for(const c of rectCells(w,d,openings))b(c.x,c.y,0,c.w,c.d,h);
 else if(e.kind==='pump'){
  b(-.18,-.15,0,w+.36,d+.3,.3);const cy=d/2,cz=h*.52,core=w*.39,r=Math.min(d*.36,h*.28),motorStart=w*.55;
  add(loftX([[.15,r*.7,r*.7],[.4,r,r],[core-.25,r,r],[core,r*.7,r*.7]],cy,cz,28));
  for(let x=.7;x<core-.25;x+=Math.max(.3,w*.04))add(loftX([[x,r+.07,r+.07],[x+.07,r+.07,r+.07]],cy,cz,24));
  add(cylinder([core,cy,cz],[motorStart,cy,cz],.14));b(core+.1,cy-.35,cz-.35,motorStart-core-.2,.7,.7);
  add(loftX([[motorStart,r*.7,r*.7],[motorStart+.3,r*1.1,r*1.1],[w-.3,r*1.1,r*1.1],[w,r*.8,r*.8]],cy,cz,28));
  for(let x=motorStart+.4;x<w-.3;x+=Math.max(.25,w*.03))add(loftX([[x,r*1.14,r*1.14],[x+.055,r*1.14,r*1.14]],cy,cz,24));
  b(motorStart+.25,cy-r*1.05,.3,w-motorStart-.5,r*2.1,.3);b(w-.9,cy+r*.65,cz+.3,.7,.7,.5);
  for(const [x,y] of [[w*.1,0],[w*.34,d]]){add(cylinder([x,cy,cz],[x,y,cz],.24));add(cylinder([x,y-.06,cz],[x,y+.06,cz],.34,20));}
 }else if(['hp','lp','generator','exciter','msr'].includes(e.kind)){
  b(0,0,0,w,d,.3);const cy=d/2,cz=h*.58,ry=d*.45,rz=h*.38;
  add(loftX([[.1,ry*.6,rz*.6],[w*.12,ry*.9,rz*.95],[w*.5,ry,rz],[w*.88,ry*.9,rz*.95],[w-.1,ry*.6,rz*.6]],cy,cz,e.kind==='lp'?40:32));
  b(.3,.1,cz-.12,w-.6,d-.2,.24);
  for(let x=w*.12;x<w*.9;x+=Math.max(.5,w*.08)){add(loftX([[x,ry*1.025,rz*1.025],[x+.07,ry*1.025,rz*1.025]],cy,cz,24));for(const y of [.22,d-.22])add(cylinder([x,y,cz+.12],[x,y,cz+.24],.08,6));}
  if(e.kind==='generator')b(w*.4,d-.2,.4,w*.22,1.2,1.5);
 }else if(e.kind==='condenser'){
  b(0,0,0,w,d,.35);b(.25,1.4,.35,w-.5,d-2.8,h-3);b(.7,2,h-2.65,w-1.4,d-4,2.65);
  for(const y of [.1,d-1.3]){b(.35,y,.6,w-.7,1.2,h-3);for(const x of [w*.3,w*.7])add(cylinder([x,y-.1,h*.45],[x,y+1.3,h*.45],.75,24));}
 }else if(e.kind==='valve'){
  b(0,0,0,w,d,.3);add(cylinder([0,d/2,h*.4],[w,d/2,h*.4],d*.22));add(cylinder([w/2,d/2,h*.4],[w/2,d/2,h*.87],.08));add(cylinder([w/2,d/2,h*.87],[w/2,d/2,h*.94],d*.23,20));
 }else if(e.kind==='stair'){
  const flights=6,steps=16,rise=h/(flights*steps),run=(d-2.8)/steps;
  for(let f=0;f<flights;f++){const x=f%2===0?.2:w/2+.2;for(let i=0;i<steps;i++){const y=f%2===0?1.4+i*run:d-1.4-(i+1)*run;b(x,y,f*h/flights+i*rise,w/2-.4,run,rise);}b(.2,f%2===0?d-1.4:.1,(f+1)*h/flights-.12,w-.4,1.3,.12);}
 }else if(e.kind==='vessel')add(cylinder([w/2,d/2,.3],[w/2,d/2,h],Math.min(w,d)/2,40));
 else if(e.kind==='riser'||e.kind==='pylon'){
  for(const x of [0,w-.15])for(const y of [0,d-.15])b(x,y,0,.15,.15,h);for(let z=1;z<h;z+=2)b(0,0,z,w,d,.12);
 }else if(e.kind==='pipe'){
  const path=JSON.parse(String(p.path)) as V3[];for(let i=1;i<path.length;i++)add(cylinder(path[i-1]!,path[i]!,number(p,'radius'),16));
 }else b(0,0,0,w,d,h);
 return mesh;
}
export function interfaces(model:Model,e:Element){
 if(e.kind!=='pump')return[];const p=parameters(model,e),w=number(p,'length'),d=number(p,'width'),h=number(p,'height');return [{id:e.id+'/inlet',position:world(e,[w*.1,0,h*.52]),direction:rotate([0,-1,0],e.yaw)},{id:e.id+'/outlet',position:world(e,[w*.34,d,h*.52]),direction:rotate([0,1,0],e.yaw)}];
}
export function envelopes(model:Model,e:Element){
 if(e.kind!=='pump')return[];const p=parameters(model,e),w=number(p,'length'),d=number(p,'width'),h=number(p,'height'),side=number(p,'serviceSide');
 return [{role:'ServiceEnvelope',task:'illustrative side access',mesh:box(0,d,0,w,side,h),evidence:'authored allowance, not OEM-qualified'},{role:'RemovalEnvelope',task:'illustrative axial motor withdrawal',mesh:box(w,0,0,w*.6,d,h),evidence:'generated proxy; rigging/support facts unknown'}];
}
export function validate(model:Model){
 if(model.metadata.sourceProfile!=='leitbild.ifc-authoring-trial-1')throw Error('UNSUPPORTED_PROFILE');
 const ids=model.elements.map(e=>e.id);if(new Set(ids).size!==ids.length)throw Error('DUPLICATE_ELEMENT_ID');
 const supported=new Set(['pump','hp','lp','generator','exciter','msr','valve','condenser','wall','slab','opening','door','stair','roof','riser','support','vessel','transformer','pylon','pipe','space']);
 for(const e of model.elements){const p=parameters(model,e);if(!supported.has(e.kind))throw Error('UNSUPPORTED_FAMILY');if(typeof e.id!=='string'||!e.id.length||e.id.length>250)throw Error('INVALID_ELEMENT_ID');if(!model.levels.some(l=>l.id===e.levelId)&&e.levelId!=='site')throw Error('UNKNOWN_LEVEL');if(e.typeId&&!model.types.some(t=>t.id===e.typeId&&t.family===e.kind))throw Error('TYPE_MISMATCH');
  for(const k of ['length','width','height']){const n=number(p,k);if(n<=0||n>1000)throw Error('DIMENSION_LIMIT');}if(e.position.some(n=>!Number.isFinite(n)||Math.abs(n)>10000)||!Number.isFinite(e.yaw))throw Error('POSITION_LIMIT');
  if(e.kind==='opening'){const host=model.elements.find(o=>o.id===e.hostId);if(!host||!['wall','slab','roof'].includes(host.kind))throw Error('INVALID_OPENING_HOST');if(host.kind==='wall'){const q=local(host,e.position),hp=parameters(model,host);if(q[0]<-1e-7||q[0]+Number(p.length)>Number(hp.length)+1e-7||q[2]<-1e-7||q[2]+Number(p.height)>Number(hp.height)+1e-7)throw Error('OPENING_OUTSIDE_WALL');}}
  if(e.spaceIds?.some(id=>!model.elements.some(s=>s.id===id&&s.kind==='space')))throw Error('MISSING_ADJACENT_SPACE');
 }
 for(const wall of model.elements.filter(e=>e.kind==='wall')){const o=model.elements.filter(e=>e.hostId===wall.id);for(let i=0;i<o.length;i++)for(let j=i+1;j<o.length;j++){const a=local(wall,o[i]!.position),b=local(wall,o[j]!.position),pa=parameters(model,o[i]!),pb=parameters(model,o[j]!);if(Math.min(a[0]+Number(pa.length),b[0]+Number(pb.length))-Math.max(a[0],b[0])>1e-7&&Math.min(a[2]+Number(pa.height),b[2]+Number(pb.height))-Math.max(a[2],b[2])>1e-7)throw Error('OVERLAPPING_OPENINGS');}}
}
