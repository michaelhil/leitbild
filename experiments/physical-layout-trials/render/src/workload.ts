import {buildScene,type SceneObject} from './reference/scene';
import {Mesh,palette} from './reference/mesh';
import {norm,cross,sub,type V3} from './reference/math';
export type Workload='slice'|'500'|'campus';
export type Instance={id:string;subjectId?:string;level:string;kind:string;mesh:Mesh;offset:V3;opacity?:number;side?:V3;lowMesh?:Mesh;imported?:boolean};
export type TrialView={level:string;explode:number;cutaway:boolean};
export const defaultView:TrialView={level:'all',explode:0,cutaway:true};
export function buildWorkload(kind:Workload):Instance[]{
 const base=buildScene().filter(o=>o.id!=='ground'&&o.kind!=='service');
 const convert=(o:SceneObject,prefix='',offset:V3=[0,0,0]):Instance=>({id:prefix+o.id,subjectId:o.componentId?prefix+o.componentId:undefined,level:o.level,kind:o.kind,mesh:o.mesh,lowMesh:o.lowMesh,side:o.side,offset,opacity:o.opacity});
 if(kind==='slice')return base.map(o=>convert(o));
 if(kind==='500'){
  const family=base.find(o=>o.id==='mfw-a')!;
  return Array.from({length:500},(_,i)=>convert(family,`test-${i}/`,[(i%25)*14-17,0,Math.floor(i/25)*5-40.4]));
 }
 const out=Array.from({length:4},(_,i)=>base.map(o=>convert(o,`unit-${i}/`,[(i%2)*110,0,Math.floor(i/2)*75]))).flat();
 const shared=new Mesh();shared.box(80,0,-45,24,.3,20,palette.plinth);shared.box(86,.3,-40,6,5,5,palette.machine);shared.box(96,0,-39,.6,20,.6,palette.steel);shared.box(96,18,-44,.6,.6,12,palette.steel);
 out.push({id:'shared-yard',kind:'context',level:'lower',mesh:shared,offset:[0,0,0]});return out;
}
export function visibleInstances(all:Instance[],view:TrialView,eye:V3):Instance[]{return all.flatMap(o=>{
 if(view.cutaway&&o.kind==='roof')return[];
 if(o.level==='link'&&(view.level!=='all'||view.explode>0))return[];
 if(o.level!=='link'&&view.level!=='all'&&o.level!==view.level)return[];
 const near=o.side&&((eye[0]-44.4-o.offset[0])*o.side[0]+(eye[2]-26.8-o.offset[2])*o.side[2])>0;
 if(o.kind==='crane'&&o.side&&view.cutaway&&near)return[];
 return [{...o,mesh:o.kind==='wall'&&view.cutaway&&(o.imported||near)&&o.lowMesh?o.lowMesh:o.mesh,offset:[o.offset[0],o.offset[1]+(view.level==='all'&&o.level==='operating'?view.explode:0),o.offset[2]] as V3}];
 });}
export type ImportedScene={schema:'layout-trial-mesh';axes:'Z-up';units:'m';objects:Array<{id:string;levelId:string;componentId?:string;kind?:string;positions:number[];normals?:number[];colors?:number[];color?:number[];indices?:number[]}>};
export function importScene(input:ImportedScene):Instance[]{
 if(input.schema!=='layout-trial-mesh'||input.units!=='m'||input.axes!=='Z-up'||!Array.isArray(input.objects)||input.objects.length>10000)throw Error('Unsupported imported trial scene');
 const ids=new Set<string>();return input.objects.map(o=>{
  if(!o.id||ids.has(o.id)||o.positions.length>20000000||!o.positions.every(Number.isFinite))throw Error('Invalid scene identity/positions');ids.add(o.id);
  const mesh=new Mesh(),indices=o.indices??Array.from({length:o.positions.length/3},(_,i)=>i);
  if(indices.length%3!==0)throw Error('Non-triangle source mesh');
  for(let t=0;t<indices.length;t+=3){const order=[indices[t]!,indices[t+2]!,indices[t+1]!],points=order.map(i=>{if(!Number.isInteger(i)||i<0||i*3+2>=o.positions.length)throw Error('Invalid mesh index');return[o.positions[i*3]!,o.positions[i*3+2]!,o.positions[i*3+1]!] as V3;}),normal=norm(cross(sub(points[1]!,points[0]!),sub(points[2]!,points[0]!)));
   for(let j=0;j<3;j++){const i=order[j]!,stride=o.colors?.length===o.positions.length/3*4?4:3,rgb=o.color??(o.colors?.length===3?o.colors:o.colors?.slice(i*stride,i*stride+3))??palette.machine;if(rgb.length!==3||!rgb.every(Number.isFinite))throw Error('Invalid source color');mesh.vertices.push(...points[j]!,...normal,...rgb);}
  }
  return{id:o.id,subjectId:o.componentId,level:o.levelId,kind:o.kind??'equipment',mesh,lowMesh:o.kind==='wall'?clipWallBelow(mesh,mesh.bounds.min[1]+1.1):undefined,imported:true,offset:[0,0,0]};
 });
}
// Explicit inspection view: clip walls at 1.1m above each wall's source base.
// This produces uncapped view fragments; original physical triangles stay intact.
export function clipWallBelow(source:Mesh,height:number):Mesh{const out=new Mesh();for(let t=0;t<source.vertices.length;t+=27){let polygon=Array.from({length:3},(_,i)=>source.vertices.slice(t+i*9,t+i*9+9));const clipped:number[][]=[];for(let i=0;i<polygon.length;i++){const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!,insideA=a[1]!<=height,insideB=b[1]!<=height;if(insideA)clipped.push(a);if(insideA!==insideB){const ratio=(height-a[1]!)/(b[1]!-a[1]!);clipped.push(a.map((v,k)=>v+(b[k]!-v)*ratio));}}polygon=clipped;for(let i=1;i<polygon.length-1;i++)out.vertices.push(...polygon[0]!,...polygon[i]!,...polygon[i+1]!);}return out;}
