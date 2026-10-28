import type {PhysicalSceneBounds} from '../../../src/core/packs/scene.ts'
import type {PhysicalSpatialIndex} from '../../../src/ui/map/physical-scene/spatial-index.ts'

/** Test-only standard centroid-midpoint prototype. Atomic leaves express the
 * hierarchy, never a model/feature limit. No source triangles are changed. */
export const createCentroidOverlapIndex=(values:readonly PhysicalSceneBounds[]):PhysicalSpatialIndex=>{
 const count=values.length,nodeCount=count?count*2-1:0
 if(!Number.isSafeInteger(nodeCount)||nodeCount>2**31)throw Error('Centroid hierarchy exceeds its signed child-index address space')
 const bounds=new Float64Array(nodeCount*6),children=new Int32Array(nodeCount*2),ranges=new Uint32Array(nodeCount*2),order=Uint32Array.from(values,(_,id)=>id)
 children.fill(-1)
 const center=(id:number,axis:number)=>values[id]!.min[axis]!*.5+values[id]!.max[axis]!*.5
 const pending=count?[{node:0,first:0,end:count}]:[];let nextNode=1
 while(pending.length){
  const{node,first,end}=pending.pop()!,at=node*6,centroidMin=[Infinity,Infinity,Infinity],centroidMax=[-Infinity,-Infinity,-Infinity]
  bounds.fill(Infinity,at,at+3);bounds.fill(-Infinity,at+3,at+6)
  for(let i=first;i<end;i++)for(let axis=0;axis<3;axis++){
   const id=order[i]!,box=values[id]!,c=center(id,axis)
   bounds[at+axis]=Math.min(bounds[at+axis]!,box.min[axis]!);bounds[at+axis+3]=Math.max(bounds[at+axis+3]!,box.max[axis]!)
   centroidMin[axis]=Math.min(centroidMin[axis]!,c);centroidMax[axis]=Math.max(centroidMax[axis]!,c)
  }
  if(end-first===1){ranges[node*2]=first;ranges[node*2+1]=1;continue}
  let axis=0
  for(let a=1;a<3;a++)if(centroidMax[a]!-centroidMin[a]!>centroidMax[axis]!-centroidMin[axis]!)axis=a
  const midpoint=centroidMin[axis]!*.5+centroidMax[axis]!*.5
  let left=first,right=end-1
  while(left<=right){
   if(center(order[left]!,axis)<midpoint)left++
   else{const value=order[left]!;order[left]=order[right]!;order[right--]=value}
  }
  let split=left
  if(split===first||split===end){
   // Identical/adjacent representable centroids may not separate at their
   // midpoint. Numeric primitive-id order gives a deterministic median split.
   order.subarray(first,end).sort();split=first+Math.floor((end-first)/2)
  }
  const a=nextNode++,b=nextNode++;children[node*2]=a;children[node*2+1]=b
  pending.push({node:b,first:split,end},{node:a,first,end:split})
 }
 if(nextNode!==(count?nodeCount:1))throw Error('Centroid hierarchy did not construct all atomic leaves')
 return{bounds,children,ranges,order}
}
