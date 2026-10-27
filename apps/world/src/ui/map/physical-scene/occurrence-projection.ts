import type { PhysicalMesh } from './geometry.ts'
import type { Vector3 } from './math.ts'
import type { PhysicalProjectedPoint } from './types.ts'

/** Immutable displayed mesh arrays are the visibility/generation boundary.
 * Preserve source order, including empty solid patches with authored strokes. */
export const createPhysicalOccurrenceMeshIndex = () => {
  const cached=new WeakMap<ReadonlyArray<PhysicalMesh>,Map<string,ReadonlyArray<PhysicalMesh>>>(),empty:ReadonlyArray<PhysicalMesh>=[]
  const group=(meshes:ReadonlyArray<PhysicalMesh>,id:string):ReadonlyArray<PhysicalMesh>=>{
    let index=cached.get(meshes)
    if(!index){
      const next=new Map<string,PhysicalMesh[]>()
      for(const mesh of meshes){const previous=next.get(mesh.object.id);if(previous)previous.push(mesh);else next.set(mesh.object.id,[mesh])}
      index=next;cached.set(meshes,index)
    }
    return index.get(id)??empty
  }
  return {
    group,
    first:(meshes:ReadonlyArray<PhysicalMesh>,id:string,levelId?:string):PhysicalMesh|undefined=>{
      const found=group(meshes,id)
      if(levelId===undefined)return found[0]
      for(const mesh of found)if(mesh.levelId===levelId)return mesh
      return undefined
    },
  }
}

/** Exact same arithmetic order as transform(matrix, point + offset), without
 * constructing intermediate position/normalised-coordinate arrays per point. */
export const projectPhysicalSpatialPoints = (matrix:ArrayLike<number>,offset:Vector3,rectangle:{readonly width:number;readonly height:number},points:ReadonlyArray<Vector3>):ReadonlyArray<PhysicalProjectedPoint>=>points.map(point=>{
  const x=point[0]+offset[0],y=point[1]+offset[1],z=point[2]+offset[2],w=matrix[3]!*x+matrix[7]!*y+matrix[11]!*z+matrix[15]!
  const px=(matrix[0]!*x+matrix[4]!*y+matrix[8]!*z+matrix[12]!)/w,py=(matrix[1]!*x+matrix[5]!*y+matrix[9]!*z+matrix[13]!)/w,pz=(matrix[2]!*x+matrix[6]!*y+matrix[10]!*z+matrix[14]!)/w
  return{x:(px+1)*rectangle.width/2,y:(1-py)*rectangle.height/2,depth:pz,visible:Math.abs(px)<=1&&Math.abs(py)<=1&&Math.abs(pz)<=1}
})
