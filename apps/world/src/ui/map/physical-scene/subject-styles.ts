import type { PhysicalPreparedGeometry } from './preparation.ts'
import type { PhysicalSubjectStyle } from './types.ts'

/** Preserve the exact first-subject agreement rule, including null colour. */
export const physicalAgreedSubjectStyle=(status:ReadonlyMap<string,PhysicalSubjectStyle>,subjects:ReadonlyArray<string>):PhysicalSubjectStyle|null=>{
  if(!subjects.length)return null
  const first=status.get(subjects[0]!)
  if(!first)return null
  for(let index=1;index<subjects.length;index++){const value=status.get(subjects[index]!);if(!value||value.emphasis!==first.emphasis||JSON.stringify(value.color)!==JSON.stringify(first.color))return null}
  return first
}
const equal=(a:PhysicalSubjectStyle|null,b:PhysicalSubjectStyle|null):boolean=>a===b||a!==null&&b!==null&&a.emphasis===b.emphasis&&(a.color===b.color||a.color!==null&&b.color!==null&&a.color.every((value,axis)=>value===b.color![axis]))
/** Source bindings and owner-qualified status maps are immutable. Camera and
 * presentation transforms do not participate in this derivation. */
export const createPhysicalSceneStyleCache=()=>{
  const assets=new WeakMap<PhysicalPreparedGeometry,{readonly off:ReadonlyArray<null>;readonly byStatus:WeakMap<ReadonlyMap<string,PhysicalSubjectStyle>,ReadonlyArray<PhysicalSubjectStyle|null>>;latest:ReadonlyArray<PhysicalSubjectStyle|null>|null}>()
  return(asset:PhysicalPreparedGeometry,status:ReadonlyMap<string,PhysicalSubjectStyle>,live:boolean):ReadonlyArray<PhysicalSubjectStyle|null>=>{
    let cached=assets.get(asset)
    if(!cached){cached={off:asset.meshes.map(()=>null),byStatus:new WeakMap(),latest:null};assets.set(asset,cached)}
    if(!live)return cached.off
    const prior=cached.byStatus.get(status);if(prior)return prior
    const next=asset.meshes.map(mesh=>physicalAgreedSubjectStyle(status,mesh.object.subjectIds)),latest=cached.latest
    const result=latest&&latest.length===next.length&&next.every((style,index)=>equal(style,latest[index]!))?latest:next
    cached.latest=result;cached.byStatus.set(status,result);return result
  }
}
