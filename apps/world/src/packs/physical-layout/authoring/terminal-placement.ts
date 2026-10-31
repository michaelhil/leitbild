import type{Source,Element,V3}from '../native/drafting/source.ts'
import{elementWorld,parameters}from '../native/drafting/source.ts'
import type{PhysicalSceneObject}from '../../../core/packs/scene.ts'
type Axis=[-1|0|1,-1|0|1,-1|0|1]
export interface PhysicalTerminalCandidate{local:V3;outward:Axis;point:V3;direction:V3;basis:'family-nozzle'|'body-surface'|'header-tap'}
const cross=(a:V3,b:V3):V3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
const sub=(a:V3,b:V3):V3=>a.map((v,i)=>v-b[i]!)as V3,dot=(a:V3,b:V3)=>a.reduce((s,v,i)=>s+v*b[i]!,0)
const cache=new WeakMap<PhysicalSceneObject,{triangles:V3[][];center:V3}>()

/** Known source-family nozzles take precedence over illustrative surface
 * placement. Coordinates follow the same normalized machinery recipes. */
export const physicalTerminalCandidates=(source:Source,e:Element,object:PhysicalSceneObject,port:string,kind:'pipe'|'electrical',toward:V3):PhysicalTerminalCandidate[]=>{
 const pose=elementWorld(source,e),c=Math.cos(pose.yaw),s=Math.sin(pose.yaw),d=parameters(source,e)
 const world=(p:V3):V3=>[pose.position[0]+c*p[0]-s*p[1]-source.origin[0],pose.position[1]+s*p[0]+c*p[1]-source.origin[1],pose.position[2]+p[2]-source.origin[2]]
 const local=(p:V3):V3=>{const x=p[0]+source.origin[0]-pose.position[0],y=p[1]+source.origin[1]-pose.position[1];return[c*x+s*y,-s*x+c*y,p[2]+source.origin[2]-pose.position[2]]}
 const candidate=(point:V3,outward:Axis,basis:PhysicalTerminalCandidate['basis']):PhysicalTerminalCandidate=>({local:point,outward,point:world(point),direction:[c*outward[0]-s*outward[1],s*outward[0]+c*outward[1],outward[2]],basis})
 if(kind==='pipe'&&(port==='inlet'||port==='outlet')){
  const inlet=port==='inlet'
  if(e.equipmentKind==='feed-pump')return[candidate(inlet?[1.2*d.length/12,.1*d.width/2.7,1.65*d.height/3.4]:[4.075*d.length/12,d.width,1.65*d.height/3.4],inlet?[0,-1,0]:[0,1,0],'family-nozzle')]
  if(e.equipmentKind==='condensate-pump')return[candidate(inlet?[0,d.width/2,1.4*d.height/3.2]:[.825*d.length/5.2,0,1.4*d.height/3.2],inlet?[-1,0,0]:[0,-1,0],'family-nozzle')]
  if(e.equipmentKind==='pump')return[candidate(inlet?[.22*d.length,.03*d.width,.45*d.height]:[.33*d.length,d.width/2,.96*d.height],inlet?[0,-1,0]:[0,0,1],'family-nozzle')]
  if(e.equipmentKind==='valve'||e.equipmentKind==='stop-valve')return[candidate([inlet?0:d.length,d.width/2,e.equipmentKind==='stop-valve'?1.3*d.height/3.1:.3*d.height],inlet?[-1,0,0]:[1,0,0],'family-nozzle')]
 }
 const result:PhysicalTerminalCandidate[]=[]
 if(e.path?.length){
  const points=e.path.map(p=>p.map((v,i)=>v-source.origin[i]!)as V3),taps=[...points]
  for(let i=1;i<points.length;i++){const a=points[i-1]!,delta=sub(points[i]!,a),length=dot(delta,delta);if(length){const t=Math.max(0,Math.min(1,dot(sub(toward,a),delta)/length));taps.push(a.map((v,axis)=>v+delta[axis]!*t)as V3)}}
  for(const tap of taps)for(const axis of[0,1,2])for(const sign of[-1,1]as const){const outward:Axis=[0,0,0];outward[axis]=sign;result.push(candidate(local(tap),outward,'header-tap'))}
  return result
 }
 let body=cache.get(object)
 if(!body){
  const triangles:V3[][]=[],min:V3=[Infinity,Infinity,Infinity],max:V3=[-Infinity,-Infinity,-Infinity],count=object.indices?.length??object.positions.length/3
  for(let i=0;i<count;i+=3){const ids=[0,1,2].map(k=>object.indices?.[i+k]??i+k);if(ids.every(id=>object.materials?.[object.materialIndices?.[id]??-1]==='plinth'))continue;const triangle=ids.map(id=>local([object.positions[id*3]!,object.positions[id*3+1]!,object.positions[id*3+2]!]));triangles.push(triangle);for(const p of triangle)for(const axis of[0,1,2]){min[axis]=Math.min(min[axis]!,p[axis]!);max[axis]=Math.max(max[axis]!,p[axis]!)}}
  body={triangles,center:min.map((v,i)=>(v+max[i]!)/2)as V3};cache.set(object,body)
 }
 // Intersect actual non-foundation faces, not empty AABB corners or plinths.
 for(const axis of[0,1,2])for(const sign of[-1,1]as const){let far=0,hit:V3|undefined
  for(const[a,b,z]of body.triangles as[V3,V3,V3][]){const normal=cross(sub(b,a),sub(z,a));if(!normal[axis])continue;const t=dot(normal,sub(a,body.center))/(sign*normal[axis]!);if(!(t>far))continue;const p=[...body.center]as V3;p[axis]=p[axis]!+sign*t
   const terms=[[a,b],[b,z],[z,a]]as[V3,V3][];if(terms.every(([u,v])=>{const side=dot(cross(sub(v,u),sub(p,u)),normal),scale=Math.hypot(...sub(v,u))*Math.hypot(...sub(p,u))*Math.hypot(...normal);return side>=-32*Number.EPSILON*scale})){far=t;hit=p}
  }
  if(hit){const outward:Axis=[0,0,0];outward[axis]=sign;result.push(candidate(hit,outward,'body-surface'))}
 }
 return result
}
