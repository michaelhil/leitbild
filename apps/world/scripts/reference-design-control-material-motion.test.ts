import {describe,expect,test} from 'bun:test'
import {axialIntervalOverlap,controlMaterialMotionAt,type ControlMaterialMotion} from './reference-design-control-material-motion'

// Deliberately small numerical clipping fixture, not plant preparation.
const plan:ControlMaterialMotion={clusters:[{id:'test-cluster',prefix:'test-stock'}],maximumTravel_m:4,
 stockIds:['test-stock'],regionIds:['lower','upper'],scope:'test-only interval',rows:[
  {cluster:0,stock:0,region:0,lo:-2,hi:2,spans:[{lo:-2,hi:2,area:3}]},
  {cluster:0,stock:0,region:1,lo:2,hi:6,spans:[{lo:-2,hi:2,area:3}]}]}
const at=(y:number,side:'increasing'|'decreasing'='increasing')=>
 controlMaterialMotionAt(plan,[{clusterId:'test-cluster',body_y_m:y,side}])

describe('moving physical material interval branches',()=>{
 test('contained translations preserve exact immutable length and moment derivative',()=>{
  const lo=-1.997,hi=2.003
  for(const y of [.003,.003567,.0048,.0018]){
   const v=axialIntervalOverlap(lo,hi,-3,3,y,true)
   expect(v[0]).toBe(hi-lo);expect(v[1]).toBe(0);expect(v[3]).toBe(hi-lo)
   expect(v[2]).toBe((hi-lo)*((lo+hi)/2+y))
   expect(axialIntervalOverlap(-3,3,-1.997,2.003,y,true)).toEqual([hi-lo,0,(hi-lo)*(lo+hi)/2,0])
  }
 })
 test('touching and coincident planes preserve both selected one-sided branches',()=>{
  expect(axialIntervalOverlap(-2,2,2,6,0,true)).toEqual([0,1,0,2])
  expect(axialIntervalOverlap(-2,2,2,6,0,false)).toEqual([0,0,0,0])
  expect(axialIntervalOverlap(-2,2,-6,-2,0,true)).toEqual([0,0,-0,-0])
  expect(axialIntervalOverlap(-2,2,-6,-2,0,false)).toEqual([0,-1,-0,2])
  expect(axialIntervalOverlap(-2,2,-2,2,0,true)).toEqual([4,-1,0,2])
  expect(axialIntervalOverlap(-2,2,-2,2,0,false)).toEqual([4,1,0,2])
  expect(axialIntervalOverlap(-2,2,2,6,-.1,true)).toEqual([0,0,0,0])
 })
 test('an initially empty neighbor receives material without new physical end surfaces',()=>{
  expect([...at(0)]).toEqual([12,-3,0,6,0,3,0,6])
  expect([...at(1)]).toEqual([9,-3,4.5,3,3,3,7.5,9])
  expect([...at(4,'decreasing')]).toEqual([0,-3,0,-6,12,3,48,18])
 })
 test('interior derivatives agree with shrinking independent centered differences',()=>{
  for(const y of [.2,1.3,3.8])for(const epsilon of [1e-3,1e-4,1e-5]){
   const value=at(y),a=at(y-epsilon),b=at(y+epsilon)
   for(const row of [0,1]){
    expect((b[4*row]!-a[4*row]!)/(2*epsilon)).toBeCloseTo(value[4*row+1]!,7)
    expect((b[4*row+2]!-a[4*row+2]!)/(2*epsilon)).toBeCloseTo(value[4*row+3]!,7)
   }
  }
 })
 test('translation conserves material and advances its actual vertical moment',()=>{
  for(const y of [0,.1,2.6,4]){
   const v=at(y,y===4?'decreasing':'increasing')
   expect(v[0]!+v[4]!).toBeCloseTo(12,12)
   expect(v[2]!+v[6]!).toBeCloseTo(12*y,12)
   expect(v[1]!+v[5]!).toBeCloseTo(0,12)
   expect(v[3]!+v[7]!).toBeCloseTo(12,12)
  }
 })
 test('refuses malformed, foreign, reordered and out-of-travel stage poses',()=>{
  expect(()=>controlMaterialMotionAt(plan,[])).toThrow('coverage')
  expect(()=>controlMaterialMotionAt(plan,[{clusterId:'foreign',body_y_m:0,side:'increasing'}])).toThrow('pose')
  for(const y of [-.001,4.001,NaN,Infinity])expect(()=>at(y)).toThrow('pose')
  expect(()=>at(0,'decreasing')).toThrow('pose')
  expect(()=>at(4,'increasing')).toThrow('pose')
 })
})
