import {describe,test,expect} from 'bun:test'
import {poolLiquidMoments as moments,poolSurfaceForVolume as surface} from './reference-design-pool-moments'

describe('displaced pool volume and first moment',()=>{
 test('empty prism and an actual bottom exclusion differ from the rejected shortcut',()=>{
  expect(moments(100,-.75,14,[])).toEqual({volume_m3:1475,firstMoment_m4:9771.875,centroid_m:6.625})
  const s=[{bottom_m:-.5,top_m:3.5,area_m2:2}],q=moments(100,-.75,14,s)
  expect(q.volume_m3).toBe(1467)
  expect(q.firstMoment_m4).toBe(9759.875)
  expect(q.centroid_m).toBeCloseTo(9759.875/1467,13)
  expect(q.centroid_m).not.toBe(-.75+q.volume_m3/200)
  expect(surface(100,-.75,15.5,q.volume_m3,s)).toBe(14)
 })
 test('partial immersion, overlapping axial intervals and datum shift preserve incidence',()=>{
  const s=[{bottom_m:0,top_m:4,area_m2:2},{bottom_m:2,top_m:6,area_m2:3}]
  const q=moments(10,-1,3,s)
  expect(q.volume_m3).toBe(31)
  expect(q.firstMoment_m4).toBe(23.5)
  expect(surface(10,-1,8,31,s)).toBe(3)
  const shifted=moments(10,99,103,s.map(v=>({...v,bottom_m:v.bottom_m+100,top_m:v.top_m+100})))
  expect(shifted.volume_m3).toBe(q.volume_m3)
  expect(shifted.firstMoment_m4-q.firstMoment_m4).toBe(100*q.volume_m3)
 })
 test('fixed-pose dI/dV equals free-surface elevation, preserving the existing port head',()=>{
  const s=[{bottom_m:0,top_m:4,area_m2:2}]
  for(const z of [1,3,5]){
    const a=moments(10,-1,z-1e-4,s),b=moments(10,-1,z+1e-4,s)
    expect((b.firstMoment_m4-a.firstMoment_m4)/(b.volume_m3-a.volume_m3)).toBeCloseTo(z,8)
  }
 })
 test('submerged vertical motion pairs liquid PE with actual buoyancy work',()=>{
  const rho=997.04763676,g=9.80665,delta=.3
  const before=moments(100,-.75,14,[{bottom_m:1,top_m:3,area_m2:2}])
  const after=moments(100,-.75,14,[{bottom_m:1+delta,top_m:3+delta,area_m2:2}])
  expect(after.volume_m3).toBe(before.volume_m3)
  expect(rho*g*(after.firstMoment_m4-before.firstMoment_m4)).toBeCloseTo(-rho*g*4*delta,6)
 })
 test('empty volume has no invented centroid; invalid volume and blocked slabs fail',()=>{
  expect(moments(10,0,0,[]).centroid_m).toBeNull()
  expect(surface(10,0,2,0,[])).toBe(0)
  expect(()=>surface(10,0,2,21,[])).toThrow('exceeds')
  expect(()=>moments(10,0,2,[{bottom_m:0,top_m:2,area_m2:11}])).toThrow('Disconnected')
  expect(()=>moments(10,0,2,[{bottom_m:1,top_m:0,area_m2:1}])).toThrow('Invalid')
 })
})
