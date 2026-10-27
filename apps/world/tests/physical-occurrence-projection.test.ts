import { expect, test } from 'bun:test'
import type { PhysicalProjectedPoint } from '../src/ui/map/physical-scene/types.ts'
import { createPhysicalOccurrenceMeshIndex, visitPhysicalSpatialPoints } from '../src/ui/map/physical-scene/occurrence-projection.ts'
const projectPhysicalSpatialPoints = (matrix:ArrayLike<number>, offset:Vector3, rectangle:{width:number;height:number}, points:ReadonlyArray<Vector3>):ReadonlyArray<PhysicalProjectedPoint> => { const values: PhysicalProjectedPoint[] = []; visitPhysicalSpatialPoints(matrix,offset,rectangle,points,(x,y,depth,visible)=>values.push({x,y,depth,visible})); return values }
import { transform, type Vector3 } from '../src/ui/map/physical-scene/math.ts'
import type { PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
const mesh=(id:string,level:string,offset:Vector3=[0,0,0]):PhysicalMesh=>({key:id+'/'+level,object:{id,label:id,kind:'pipe',levelId:level,positions:[],subjectIds:[id]},vertices:[],lines:[0,0,0,1,1,1],levelId:level,offset,bounds:{min:[0,0,0],max:[1,1,1]}})

test('indexed first occurrence/level matches the original linear query through visibility/source/offset changes',()=>{
 const index=createPhysicalOccurrenceMeshIndex(),a=mesh('same','lower'),b=mesh('same','operating',[0,0,5]),c=mesh('other','operating'),d=mesh('same','operating',[0,0,9]),source=[a,c,b,d]
 for(const visible of [source,source.filter(value=>value!==b),source.slice(1),[d,b,c],[{...b,offset:[0,0,17] as Vector3},c],[]])for(const id of ['same','other','missing'])for(const level of [undefined,'lower','operating','absent'])expect(index.first(visible,id,level)).toBe(visible.find(candidate=>candidate.object.id===id&&(level===undefined||candidate.levelId===level)))
 expect(index.group(source,'same')).toBe(index.group(source,'same'));expect(index.group(source,'same')).toEqual([a,b,d]);expect(index.first(source,'same')).toBe(a)
})

test('scalar projection preserves exact original floating operations for varied matrices, offsets, floors and viewport sizes',()=>{
 let seed=9467;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32},point=():Vector3=>[random()*20-10,random()*20-10,random()*20-10]
 for(let matrixId=0;matrixId<32;matrixId++){
  const matrix=Float64Array.from({length:16},()=>random()*4-2),offset=point(),rectangle={width:300+random()*1400,height:200+random()*900},points=Array.from({length:128},point),actual=projectPhysicalSpatialPoints(matrix,offset,rectangle,points)
  const expected=points.map(point=>{const p=transform(matrix,point.map((value,axis)=>value+offset[axis]!) as unknown as Vector3);return{x:(p[0]+1)*rectangle.width/2,y:(1-p[1])*rectangle.height/2,depth:p[2],visible:Math.abs(p[0])<=1&&Math.abs(p[1])<=1&&Math.abs(p[2])<=1}})
  expect(actual).toEqual(expected)
 }
})

test('projection preserves empty inputs, negative and zero homogeneous w without a silent finite fallback',()=>{
 const matrix=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0]),rectangle={width:1080,height:871},points:Vector3[]=[[0,0,0],[1,-1,1]],actual=projectPhysicalSpatialPoints(matrix,[0,0,0],rectangle,points)
 expect(projectPhysicalSpatialPoints(matrix,[0,0,0],rectangle,[])).toEqual([]);expect(actual[0]!.x).toBeNaN();expect(actual[1]!.x).toBe(Infinity);expect(actual.every(point=>!point.visible)).toBe(true)
 matrix[15]=-1;expect(projectPhysicalSpatialPoints(matrix,[0,0,0],rectangle,[[1,0,0]])[0]).toEqual({x:0,y:435.5,depth:-0,visible:true})
})
