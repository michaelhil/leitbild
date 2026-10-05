import {describe,expect,test} from 'bun:test'
import {compileSourcePartition,diskRectangleArea,parseSourcePartition} from './reference-design-source-partition'
import {fuelAssemblyPositions} from './reference-design-fuel-handling'

import {fixture} from './reference-design-source.test-fixture'
describe('fixed source geometry compilation',()=>{
 test('analytic disk intersections conserve area across arbitrary Cartesian cuts',()=>{
  for(const radius of [.2,1,2.2496739661439764]){
   const cuts=[-3,-.95,-.17,0,.41,1.11,3],areas=[]
   for(let y=1;y<cuts.length;y++)for(let x=1;x<cuts.length;x++){
    const box={x0:cuts[x-1]!,x1:cuts[x]!,y0:cuts[y-1]!,y1:cuts[y]!},a=diskRectangleArea(radius,box)
    expect(a).toBeGreaterThanOrEqual(0);expect(a).toBeLessThanOrEqual((box.x1-box.x0)*(box.y1-box.y0)+1e-12)
    expect(a).toBeCloseTo(diskRectangleArea(radius,{x0:box.y0,x1:box.y1,y0:box.x0,y1:box.x1}),11);areas.push(a)
   }
   expect(areas.reduce((sum,a)=>sum+a,0)).toBeCloseTo(Math.PI*radius**2,11)
  }
  expect(diskRectangleArea(1,{x0:1,x1:2,y0:-1,y1:1})).toBe(0)
  expect(diskRectangleArea(1,{x0:0,x1:1,y0:0,y1:1})).toBeCloseTo(Math.PI/4,13)
  expect(()=>diskRectangleArea(-1,{x0:0,x1:1,y0:0,y1:1})).toThrow()
 })
 test('actual generation closes all gross regions and preserves identities',()=>{
  const r=compileSourcePartition(fixture)
  expect(r.counts).toEqual({ACTIVE:1508,LOWER:1,UPPER:1,WELL:300,CANAL:48,POOL:3168})
  expect(r.regionCount).toBe(5026);expect(r.neutronCoordinates).toBe(35182)
  expect(r.assemblies).toHaveLength(193);expect(r.racks).toHaveLength(196)
  expect(r.assemblies).toEqual(fuelAssemblyPositions(fixture.handling,fixture.fuel))
  expect(r.headArea_m2).toBeCloseTo(16.75,11)
  expect(r.representedDownVolume_m3).toBeCloseTo(40/3,12)
  expect(r.uncreditedDownEndVolume_m3).toBeCloseTo(20/3,12)
  for(const v of r.volumes)expect(v.compiled_m3).toBeCloseTo(v.expected_m3,8)
  for(const rack of r.racks){const pieces=r.regions.filter(q=>q.rackId===rack.id)
   expect(pieces.filter(q=>q.part!=='whole')).toHaveLength(10)
   expect(new Set(pieces.map(q=>q.envelopeLength_m)).size).toBe(1)
   expect(pieces.reduce((sum,q)=>sum+q.volume_m3,0)).toBeCloseTo(.25*14.75,11)
  }
 })
 test('source numerical refinement changes no equipment or compartment stock',()=>{
  const a=compileSourcePartition(fixture),b=compileSourcePartition({...fixture,partition:{coreBands:8}})
  expect(b.counts.ACTIVE).toBe(2*a.counts.ACTIVE!);expect(b.assemblies).toEqual(a.assemblies);expect(b.racks).toEqual(a.racks)
  for(let i=0;i<a.volumes.length;i++)expect(b.volumes[i]!.compiled_m3).toBeCloseTo(a.volumes[i]!.compiled_m3,9)
  expect(b.regions[0]!.envelopeLength_m).toBe(a.regions[0]!.envelopeLength_m)
 })
 test('invalid supports and ambiguous partition records fail visibly',()=>{
  const doc='```reference-source-partition\n{"coreBands":4}\n```\n'
  expect(parseSourcePartition(doc)).toEqual({coreBands:4});expect(()=>parseSourcePartition(doc+doc)).toThrow()
  expect(()=>parseSourcePartition(doc.replace('"coreBands":4','"coreBands":4,"shape":[]'))).toThrow()
  expect(()=>parseSourcePartition(doc.replace('"coreBands":4','"coreBands":0'))).toThrow()
  expect(()=>compileSourcePartition({...fixture,handling:{...fixture.handling,rackPitch_m:.6}})).toThrow()
  expect(()=>compileSourcePartition({...fixture,control:{...fixture.control,headGrossArea_m2:30}})).toThrow()
  expect(()=>compileSourcePartition({...fixture,primary:{...fixture.primary,downcomerTop_m:1}})).toThrow()
  expect(()=>fuelAssemblyPositions(fixture.handling,{...fixture.fuel,assemblies:194})).toThrow()
 })
})
