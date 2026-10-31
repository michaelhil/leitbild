import type { PhysicalDraw } from './backend.ts'
import type { PhysicalMesh } from './geometry.ts'
import type { Color } from './types.ts'
import { physicalArchitectureOpacity } from './architecture-opacity.ts'
interface Stamp {
  readonly asset:WeakRef<PhysicalDraw['asset']>
  readonly base:WeakRef<ReadonlyArray<PhysicalMesh>>
  readonly meshes:WeakRef<PhysicalDraw['meshes']>
  readonly styles:WeakRef<PhysicalDraw['styles']>
  readonly wall:number;readonly floor:number
  readonly red:number;readonly green:number;readonly blue:number
  readonly highlighted:string|undefined;readonly highlight:Color|null
}
const write=(data:Float32Array,at:number,a:number,b:number,c:number,d:number):boolean=>{
  let changed=false
  if(data[at]!==Math.fround(a)){data[at]=a;changed=true}
  if(data[at+1]!==Math.fround(b)){data[at+1]=b;changed=true}
  if(data[at+2]!==Math.fround(c)){data[at+2]=c;changed=true}
  if(data[at+3]!==Math.fround(d)){data[at+3]=d;changed=true}
  return changed
}
/** Current per-instance metadata only. Weak stamps never make a cached GPU
 * asset an accidental strong owner of CPU source/mesh/preparation geometry. */
export const createPhysicalObjectTableRows=()=>{
  const states:Stamp[]=[],shownCache=new WeakMap<PhysicalDraw['meshes'],{readonly base:WeakRef<ReadonlyArray<PhysicalMesh>>;readonly values:Map<number,PhysicalMesh>}>();let target:WeakRef<Float32Array>|null=null
  return (data:Float32Array,base:ReadonlyArray<PhysicalMesh>,draws:ReadonlyArray<PhysicalDraw>,fallback:Color,force=false):{readonly changed:boolean;readonly updatedInstances:number;readonly reusedInstances:number}=>{
    const allocated=force||target?.deref()!==data;target=new WeakRef(data)
    let changed=false,updatedInstances=0,reusedInstances=0
    for(let instance=0;instance<draws.length;instance++){
      const draw=draws[instance]!,previous=states[instance],wall=draw.architecture?.wallOpacity??1,floor=draw.architecture?.floorOpacity??1,highlight=draw.highlight?.color??null
      const sameHighlight=previous?.highlighted===draw.highlight?.occurrenceId&&(previous?.highlight===highlight||previous?.highlight!==null&&highlight!==null&&previous?.highlight?.every((value,axis)=>value===highlight[axis]))
      if(!allocated&&previous&&previous.asset.deref()===draw.asset&&previous.base.deref()===base&&previous.meshes.deref()===draw.meshes&&previous.styles.deref()===draw.styles&&previous.wall===wall&&previous.floor===floor&&previous.red===fallback[0]&&previous.green===fallback[1]&&previous.blue===fallback[2]&&sameHighlight){reusedInstances++;continue}
      updatedInstances++
      let shown=shownCache.get(draw.meshes)
      if(!shown||shown.base.deref()!==base){const values=new Map<number,PhysicalMesh>();for(const mesh of draw.meshes)values.set(mesh.assetIndex??base.indexOf(mesh),mesh);shown={base:new WeakRef(base),values};shownCache.set(draw.meshes,shown)}
      for(let object=0;object<base.length;object++){
        const mesh=base[object]!,displayed=shown.values.get(object),style=draw.styles[object],at=(instance*base.length+object)*12,color=style?.color??fallback,offset=displayed?.offset??mesh.offset
        changed=write(data,at,color[0],color[1],color[2],style?.color?style.emphasis:0)||changed
        changed=write(data,at+4,offset[0],offset[1],offset[2],displayed?physicalArchitectureOpacity(mesh.object,draw.architecture??{}):0)||changed
        const selection=draw.highlight?.occurrenceId===mesh.object.id?draw.highlight.color:null
        changed=write(data,at+8,selection?.[0]??0,selection?.[1]??0,selection?.[2]??0,selection ? .24 : 0)||changed
      }
      states[instance]={asset:new WeakRef(draw.asset),base:new WeakRef(base),meshes:new WeakRef(draw.meshes),styles:new WeakRef(draw.styles),wall,floor,red:fallback[0],green:fallback[1],blue:fallback[2],highlighted:draw.highlight?.occurrenceId,highlight:highlight?[...highlight]:null}
    }
    states.length=draws.length
    return{changed,updatedInstances,reusedInstances}
  }
}
