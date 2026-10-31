import { createHash } from 'node:crypto'
import { physicalSourceSchema, elementWorld, type V3 } from '../../src/packs/physical-layout/native/drafting/source.ts'
import { compilePhysicalObjects } from '../../src/packs/physical-layout/native/drafting/compile-scene.ts'
const args=new Map(Bun.argv.slice(2).map(arg=>{const at=arg.indexOf('=');if(at<1)throw Error(`Expected --source=path or --output=path: ${arg}`);return [arg.slice(0,at),arg.slice(at+1)]}))
const file=args.get('--source')??new URL('../../src/packs/physical-layout/pwr-full-unit-connected.source.json',import.meta.url)
const bytes=await Bun.file(file).text(),source=physicalSourceSchema.parse(JSON.parse(bytes)),objects=compilePhysicalObjects({source,bindings:[]}),byId=new Map(objects.map(o=>[o.id,o])),elements=new Map(source.elements.map(e=>[e.id,e]))
const sub=(a:readonly number[],b:readonly number[]):V3=>a.map((v,i)=>v-b[i]!)as V3,dot=(a:V3,b:V3)=>a.reduce((s,v,i)=>s+v*b[i]!,0),cross=(a:V3,b:V3):V3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],point=(a:V3,d:V3,t:number):V3=>a.map((v,i)=>v+d[i]!*t)as V3
const closest=(p:V3,a:V3,b:V3,c:V3):V3=>{
 const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);if(d1<=0&&d2<=0)return a
 const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0&&d4<=d3)return b
 const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0)return point(a,ab,d1/(d1-d3))
 const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0&&d5<=d6)return c
 const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0)return point(a,ac,d2/(d2-d6))
 const va=d3*d6-d5*d4;if(va<=0&&d4-d3>=0&&d5-d6>=0)return point(b,sub(c,b),(d4-d3)/(d4-d3+d5-d6))
 const v=vb/(va+vb+vc),w=vc/(va+vb+vc);return a.map((n,i)=>n+ab[i]!*v+ac[i]!*w)as V3
}
const contacts=source.routing!.terminals.map(t=>{
 const e=elements.get(t.elementId)!,pose=elementWorld(source,e),c=Math.cos(pose.yaw),s=Math.sin(pose.yaw),world:V3=[pose.position[0]+c*t.local[0]-s*t.local[1],pose.position[1]+s*t.local[0]+c*t.local[1],pose.position[2]+t.local[2]],p=sub(world,source.origin),o=byId.get(e.id)!
 let minimum=Infinity,windingAngle=0,closestPoint:V3|undefined,triangles=0
 const count=o.indices?.length??o.positions.length/3
 for(let at=0;at<count;at+=3){const ids=[0,1,2].map(i=>o.indices?.[at+i]??at+i);if(ids.every(i=>o.materials?.[o.materialIndices?.[i]??-1]==='plinth'))continue
  const [a,b,c]=ids.map(i=>[o.positions[i*3]!,o.positions[i*3+1]!,o.positions[i*3+2]!]as V3)as[V3,V3,V3]
  if(Math.hypot(...cross(sub(b,a),sub(c,a)))===0)continue;triangles++
  const q=closest(p,a,b,c),distance=Math.hypot(...sub(p,q));if(distance<minimum){minimum=distance;closestPoint=q}
  const x=sub(a,p),y=sub(b,p),z=sub(c,p),lx=Math.hypot(...x),ly=Math.hypot(...y),lz=Math.hypot(...z)
  windingAngle+=2*Math.atan2(dot(x,cross(y,z)),lx*ly*lz+dot(x,y)*lz+dot(y,z)*lx+dot(z,x)*ly)
 }
 const uses=source.routing!.connections.filter(r=>r.from===t.id||r.to===t.id).map(r=>({route:r.id,material:r.material,endpointError:Math.hypot(...sub(r.from===t.id?r.solution![0]!:r.solution!.at(-1)!,world))}))
 return{id:t.id,elementId:e.id,family:e.equipmentKind??e.kind,point:p,nearestBodyDistance:minimum,closestPoint,winding:windingAngle/(4*Math.PI),triangles,uses}
})
const suspicious=contacts.filter(c=>c.nearestBodyDistance>source.routing!.geometryTolerance&&Math.abs(c.winding)<.5)
const receipt={sourceSha256:createHash('sha256').update(bytes).digest('hex'),sourceId:source.id,origin:source.origin,northAxis:source.northAxis,geometryTolerance:source.routing!.geometryTolerance,contacts:contacts.length,routes:source.routing!.connections.length,maxRouteEndpointError:Math.max(...contacts.flatMap(c=>c.uses.map(u=>u.endpointError))),suspicious,all:contacts}
const legacy=source.elements.filter(e=>e.kind==='pipe'&&['main-steam-route','feedwater-route'].includes(e.id)).map(e=>({id:e.id,ends:[e.path![0]!,e.path!.at(-1)!].map(world=>{
 const p=sub(world,source.origin),nearest:{id:string;distance:number;point:V3}[]=[]
 for(const o of objects.filter(o=>elements.get(o.id)?.kind==='equipment')){let distance=Infinity,hit:V3=[0,0,0];for(let at=0;at<(o.indices?.length??o.positions.length/3);at+=3){const ids=[0,1,2].map(i=>o.indices?.[at+i]??at+i);if(ids.every(i=>o.materials?.[o.materialIndices?.[i]??-1]==='plinth'))continue;const[a,b,c]=ids.map(i=>[o.positions[i*3]!,o.positions[i*3+1]!,o.positions[i*3+2]!]as V3)as[V3,V3,V3];if(Math.hypot(...cross(sub(b,a),sub(c,a)))===0)continue;const q=closest(p,a,b,c),d=Math.hypot(...sub(p,q));if(d<distance){distance=d;hit=q}}
 nearest.push({id:o.id,distance,point:hit})}
 return{world,nearest:nearest.sort((a,b)=>a.distance-b.distance).slice(0,3)}
})}))
Object.assign(receipt,{legacy})
const output=args.get('--output');if(output)await Bun.write(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({...receipt,all:undefined},null,2));if(receipt.suspicious.length||receipt.maxRouteEndpointError!==0)throw Error('An authored terminal or accepted route endpoint failed the contact audit')
