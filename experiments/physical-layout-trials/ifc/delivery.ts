import {mkdir} from 'node:fs/promises';
import {body,parameters,world,local,bounds,interfaces,envelopes,hash,type Model,type Element,type Mesh,type V3} from './model.ts';
import {read} from './ifc.ts';

const colors:Record<string,number[]>={wall:[.72,.74,.73],slab:[.87,.88,.86],roof:[.83,.84,.82],pump:[.25,.48,.55],hp:[.36,.52,.57],lp:[.36,.52,.57],generator:[.27,.40,.48],exciter:[.27,.40,.48],msr:[.61,.67,.67],valve:[.45,.57,.57],condenser:[.41,.57,.62],stair:[.62,.67,.65],support:[.35,.42,.43],pipe:[.37,.58,.61],pylon:[.5,.55,.52],transformer:[.43,.5,.54],door:[.72,.58,.39],vessel:[.38,.53,.58]};
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const r=(n:number)=>Math.round(n*1e6)/1e6;
export const worldMesh=(e:Element,m:Mesh):Mesh=>({positions:Array.from({length:m.positions.length/3},(_,i)=>world(e,m.positions.slice(i*3,i*3+3) as V3)).flat(),indices:m.indices});
export function svg(model:Model,levelId:string,editOnly=false){
 const els=model.elements.filter(e=>e.levelId===levelId&&(editOnly?e.id.startsWith('edit-')||['access-door','access-opening','existing-opening','existing-door','fixed-vessel'].includes(e.id):!e.id.startsWith('edit-')&&!['existing-opening','existing-door','fixed-vessel'].includes(e.id)));
 const vb=editOnly?'104 -8 32 36':'-4 -4 100 63';
 const out=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="1400" height="900"><rect x="-200" y="-200" width="600" height="600" fill="#f4f3ed"/><style>text{font-family:Arial,sans-serif;fill:#344349} .fine{stroke:#637175;stroke-width:.045;fill:none} .body{stroke:#2b454d;stroke-width:.09;fill:#c0d0d2} .wall{stroke:#25383d;stroke-width:.1;fill:#c2c5bf} .label{font-size:.62px;letter-spacing:.03px}</style>`];
 const rect=(x:number,y:number,w:number,h:number,c='body',extra='')=>`<rect class="${c}" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" ${extra}/>`;
 for(const e of els.filter(e=>e.kind==='slab')){const p=parameters(model,e);out.push(`<g transform="translate(${e.position[0]} ${e.position[1]}) rotate(${e.yaw*180/Math.PI})">${rect(0,0,Number(p.length),Number(p.width),'fine','fill="#e8e9e3"')}</g>`);}
 for(const e of els.filter(e=>e.kind==='wall')){const p=parameters(model,e),w=Number(p.length),d=Number(p.width),cut=(model.levels.find(l=>l.id===levelId)?.elevation??0)+1.2,open=model.elements.filter(o=>o.hostId===e.id&&o.kind==='opening'&&o.position[2]<=cut&&o.position[2]+Number(parameters(model,o).height)>cut).map(o=>({x:local(e,o.position)[0],w:Number(parameters(model,o).length)})).sort((a,b)=>a.x-b.x);let at=0;
  out.push(`<g data-element-id="${esc(e.id)}" transform="translate(${e.position[0]} ${e.position[1]}) rotate(${e.yaw*180/Math.PI})">`);for(const o of open){if(o.x>at)out.push(rect(at,0,o.x-at,d,'wall'));at=o.x+o.w;}if(at<w)out.push(rect(at,0,w-at,d,'wall'));out.push('</g>');
 }
 for(const e of els.filter(e=>e.kind==='door')){const p=parameters(model,e),w=Number(p.length);out.push(`<g data-element-id="${esc(e.id)}" transform="translate(${e.position[0]} ${e.position[1]}) rotate(${e.yaw*180/Math.PI})"><path d="M 0 0 L 0 ${w} M ${w} 0 A ${w} ${w} 0 0 1 0 ${w}" fill="none" stroke="#54666a" stroke-width=".065"/><path d="M 0 0 L 0 ${w}" stroke="#31494e" stroke-width=".11"/></g>`);}
 for(const e of els.filter(e=>!['wall','slab','roof','opening','door','space'].includes(e.kind))){
  const p=parameters(model,e),w=Number(p.length),d=Number(p.width);out.push(`<g data-element-id="${esc(e.id)}" transform="translate(${e.position[0]} ${e.position[1]}) rotate(${e.yaw*180/Math.PI})">`);
  if(e.kind==='pump'){
   out.push(rect(-.18,-.15,w+.36,d+.3,'fine','fill="#e0e4df"'),`<path class="body" d="M .15 ${d*.23} Q ${w*.17} ${-d*.05} ${w*.39} ${d*.23} L ${w*.39} ${d*.77} Q ${w*.17} ${d*1.05} .15 ${d*.77} Z"/>`,rect(w*.55,d*.13,w*.45,d*.74));
   for(let x=w*.59;x<w-.2;x+=Math.max(.25,w*.03))out.push(`<path class="fine" d="M ${x} ${d*.09} V ${d*.91}"/>`);
   out.push(rect(w*.39,d*.36,w*.16,d*.28,'fine','fill="#c8b990"'),`<path class="fine" d="M ${w*.1} 0 V ${d*.2} M ${w*.34} ${d} V ${d*.8}"/>`);
  }else if(['hp','lp','generator','exciter','msr'].includes(e.kind)){
   out.push(rect(0,0,w,d,'fine','fill="#e0e4df"'),`<path class="body" d="M .1 ${d*.28} Q ${w*.2} ${-d*.03} ${w*.5} ${d*.04} Q ${w*.8} ${-d*.03} ${w-.1} ${d*.28} L ${w-.1} ${d*.72} Q ${w*.8} ${d*1.03} ${w*.5} ${d*.96} Q ${w*.2} ${d*1.03} .1 ${d*.72} Z"/>`,`<path class="fine" d="M -.6 ${d/2} H ${w+.6}"/>`);
   for(let x=w*.13;x<w*.9;x+=Math.max(.5,w*.08))out.push(`<path class="fine" d="M ${x} ${d*.12} V ${d*.88}"/>`);
   if(e.kind==='lp')for(const y of [.25,d-.25])for(let x=.7;x<w-.5;x+=.9)out.push(`<circle cx="${x}" cy="${y}" r=".055" fill="#445b61"/>`);
  }else if(e.kind==='condenser'){out.push(rect(0,0,w,d),rect(.5,1.4,w-1,d-2.8,'fine'));for(let y=1.8;y<d-1.7;y+=.7)out.push(`<path class="fine" d="M .8 ${y} H ${w-.8}"/>`);}
  else if(e.kind==='stair'){out.push(rect(0,0,w,d,'fine'));for(let y=1.4;y<d-1.3;y+=(d-2.8)/16)out.push(`<path class="fine" d="M .2 ${y} H ${w/2-.1} M ${w/2+.2} ${y} H ${w-.2}"/>`);out.push(`<path class="fine" d="M ${w*.25} ${d-1} V 1 L ${w*.25-.3} 1.5 M ${w*.25} 1 L ${w*.25+.3} 1.5"/>`);}
  else if(e.kind==='pipe'){const pts=JSON.parse(String(p.path)) as V3[];out.push(`<polyline points="${pts.map(q=>q.slice(0,2).join(',')).join(' ')}" fill="none" stroke="#668f96" stroke-width="${Number(p.radius)*2}"/>`);}
  else out.push(rect(0,0,w,d,e.kind==='support'?'wall':'body'));
  if(e.componentId)out.push(`<text class="label" x="${w/2}" y="${d+1}" text-anchor="middle">${esc(e.id.split('/').at(-1)!)}</text>`);out.push('</g>');
 }
 if(!editOnly)out.push(`<text x="0" y="-1.8" font-size="1.05">${levelId==='lower'?'CONDENSER / FEEDWATER DECK · +0.000 m':'TURBINE OPERATING DECK · +15.000 m'}</text><text x="23" y="8" font-size="1.1">TURBINE HALL</text>${levelId==='lower'?'<text x="21" y="39" font-size=".9">FEEDWATER PUMP ROOM</text>':''}<path d="M 0 56 H 10 M 0 55.7 V 56.3 M 5 55.7 V 56.3 M 10 55.7 V 56.3" stroke="#344349" stroke-width=".1"/><text x="0" y="57.5" font-size=".65">0              5             10 m</text><text x="24" y="57.5" font-size=".6">Illustrative geometry · saved IFC source · no engineering qualification</text>`);
 out.push('</svg>');return out.join('\n');
}
export async function deliver(bytes:Uint8Array,directory:string){
 const parsed=await read(bytes),m=parsed.model;await mkdir(directory,{recursive:true});
 const objects=m.elements.filter(e=>!['space','opening'].includes(e.kind)).map(e=>{const mesh=worldMesh(e,parsed.nativeBodies.get(e.id)!);return {id:e.id,levelId:e.levelId,componentId:e.componentId,memberId:e.memberId,ownerId:e.ownerId,kind:e.kind,...mesh,color:colors[e.kind]??[.5,.55,.55],bounds:bounds(mesh)};});
 const scene={schema:'layout-trial-mesh',axes:'Z-up',units:'m',sourceSha256:hash(bytes),objects};
 const readModel={id:m.id,revision:m.revision,sourceSha256:hash(bytes),levels:m.levels,metadata:m.metadata,types:m.types,elements:m.elements.map(e=>({id:e.id,globalId:parsed.globalIds.get(e.id),kind:e.kind,levelId:e.levelId,position:e.position,yaw:e.yaw,typeId:e.typeId,parameters:parameters(m,e),componentId:e.componentId,memberId:e.memberId,ownerId:e.ownerId,hostId:e.hostId,fillsId:e.fillsId,spaceIds:e.spaceIds,bounds:bounds(worldMesh(e,parsed.nativeBodies.get(e.id)!)),interfaces:interfaces(m,e),envelopes:envelopes(m,e).map(v=>({role:v.role,task:v.task,evidence:v.evidence,bounds:bounds(worldMesh(e,v.mesh))}))})),nativeEntityCounts:parsed.nativeEntityCounts,nativeTessellation:parsed.nativeTessellation};
 await Promise.all([Bun.write(directory+'/scene.json',JSON.stringify(scene)),Bun.write(directory+'/read-model.json',JSON.stringify(readModel,null,2)),Bun.write(directory+'/plan-lower.svg',svg(m,'lower')),Bun.write(directory+'/plan-operating.svg',svg(m,'operating')),Bun.write(directory+'/plan-edit-cell.svg',svg(m,'edit-cell',true))]);return {objects:objects.length,triangles:objects.reduce((n,o)=>n+o.indices.length/3,0),sceneBytes:JSON.stringify(scene).length,nativeEntityCounts:parsed.nativeEntityCounts};
}
