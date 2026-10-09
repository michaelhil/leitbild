import {describe,expect,test} from 'bun:test'
import {axialIntervalOverlap,controlMaterialMotionAt,controlSteelMotionAt,type ControlMaterialMotion,type ControlSteelMotion} from './reference-design-control-material-motion'

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

describe('explicit signed STEM material domain',()=>{
 const signed:ControlSteelMotion={clusters:[{id:'test-cluster',prefix:'test-stock'}],minimum:{body:0,stem:-.5},
  maximum:{body:4,stem:4},stockIds:['test-stock'],regionIds:['lower','center','upper'],rows:[
   {cluster:0,stock:0,region:0,motion:'stem',lo:-6,hi:-2,spans:[{lo:-2,hi:2,area:3}]},
   {cluster:0,stock:0,region:1,motion:'stem',lo:-2,hi:2,spans:[{lo:-2,hi:2,area:3}]},
   {cluster:0,stock:0,region:2,motion:'stem',lo:2,hi:6,spans:[{lo:-2,hi:2,area:3}]},
  ]},at=(y:number,side:'increasing'|'decreasing')=>controlSteelMotionAt(signed,[
   {clusterId:'test-cluster',body_y_m:0,side:'increasing',stem_y_m:y,stem_side:side}])
 test('negative entering rows retain identity and all legal cut derivatives close V/J',()=>{
  for(const y of [-.5,0,.3,4])for(const side of ['increasing','decreasing'] as const){
   if(y===-.5&&side==='decreasing'||y===4&&side==='increasing')continue
   const v=at(y,side),sum=(k:number)=>[0,1,2].reduce((s,i)=>s+v[4*i+k]!,0)
   expect(sum(0)).toBeCloseTo(12,13);expect(sum(1)).toBeCloseTo(0,13)
   expect(sum(2)).toBeCloseTo(12*y,13);expect(sum(3)).toBeCloseTo(12,13)
  }
  expect(at(0,'decreasing')[0]).toBe(0);expect(at(0,'decreasing')[1]).toBe(-3)
  expect(at(-.5,'increasing')[0]).toBe(1.5)
  expect(at(0,'increasing')).toEqual(at(0,'increasing'))
 })
 test('STEM zero may decrease, actual lower endpoint may not; BODY remains nonnegative',()=>{
  expect(()=>at(0,'decreasing')).not.toThrow()
  expect(()=>at(-.5,'decreasing')).toThrow('pose')
  expect(()=>at(-.500001,'increasing')).toThrow('pose')
  expect(()=>controlSteelMotionAt(signed,[{clusterId:'test-cluster',body_y_m:-.01,side:'increasing',
   stem_y_m:0,stem_side:'increasing'}])).toThrow('pose')
 })
})
