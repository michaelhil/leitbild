import { expect, test } from 'bun:test'
import { createPhysicalGroundProjector } from '../src/ui/map/physical-scene/ground-projection.ts'
import { transform } from '../src/ui/map/physical-scene/math.ts'

test('ground roster shares one exact projection snapshot per camera/resize revision',()=>{
 let calls=0,width=1440,height=913,matrix=new Float64Array([2,.3,.1,.2,.4,-2,.2,.1,.1,.2,-1,-.4,-.7,.8,.9,1])
 const project=createPhysicalGroundProjector(()=>{calls++;return{matrix,width,height}})
 const expected=(x:number,y:number)=>{const p=transform(matrix,[x,y,0]);return{x:(p[0]+1)*width/2,y:(1-p[1])*height/2}}
 for(let i=0;i<1000;i++){const x=i/1000,y=(i%7)/10;expect(project(0,{x,y})).toEqual(expected(x,y))};expect(calls).toBe(1)
 // Newly admitted source bounds alter only near/far clip Z at an unchanged
 // camera. Ground XY/W remains exact and must not rescan every source/point.
 matrix=matrix.slice();for(const index of [2,6,10,14])matrix[index]=matrix[index]!*17
 expect(project(0,{x:.2,y:.4})).toEqual(expected(.2,.4));expect(calls).toBe(1)
 matrix=matrix.slice();matrix[12]=-.3
 expect(project(1,{x:.2,y:.4})).toEqual(expected(.2,.4));expect(calls).toBe(2)
 width=638;height=720;expect(project(2,{x:.2,y:.4})).toEqual(expected(.2,.4));expect(calls).toBe(3)
})
