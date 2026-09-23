import {describe,expect,test} from 'bun:test'
import {pzrHeadOpenings,shellContactGeometry} from './reference-design-pressurizer-shell-contact'

describe('actual finite shell and two independent head boundaries',()=>{
 test('fixed shell bands cover12m once and retain actual cylindrical steel',()=>{
  const g=shellContactGeometry(),r=Math.sqrt(5/Math.PI)
  expect(g.shell).toHaveLength(5)
  expect(g.shell.reduce((s,x)=>s+x.area_m2,0)).toBeCloseTo(2*Math.PI*r*12,10)
  expect(g.shell.reduce((s,x)=>s+x.steelMass_kg,0)).toBeCloseTo(7920*Math.PI*((r+.15)**2-r*r)*12,8)
 })
 test('both orientations have actual inner/outer recipients without duplicate fluid',()=>{
  const g=shellContactGeometry()
  for(const name of ['bottom','top']){
   const patches=g.heads.filter(x=>x.name===name)
   expect(patches).toHaveLength(2)
   expect(patches.map(x=>x.lane)).toEqual(['inner','outer'])
   expect(patches.reduce((s,x)=>s+x.grossSolidArea_m2,0)).toBe(5)
   const apertures=g.openings.filter(x=>x.head===name).reduce((s,x)=>s+x.area_m2,0)
   expect(patches.reduce((s,x)=>s+x.area_m2,0)).toBeCloseTo((name==='bottom'?5-288*Math.PI*.01**2:5)-apertures,10)
   expect(patches.reduce((s,x)=>s+x.steelMass_kg,0)).toBe(5940)
   expect(patches[0]!.orientation).toBe(name==='bottom'?'upward':'downward')
  }
 })
 test('actual openings are disjoint and wholly in the outer annulus',()=>{
  const openings=pzrHeadOpenings(),ri=Math.sqrt(.5/Math.PI),ro=Math.sqrt(5/Math.PI)
  expect(openings).toHaveLength(32)
  expect(Math.min(...openings.map(x=>Math.hypot(x.x_m,x.y_m)-x.diameter_m/2-ri))).toBeGreaterThan(0)
  expect(Math.min(...openings.map(x=>ro-Math.hypot(x.x_m,x.y_m)-x.diameter_m/2))).toBeGreaterThan(0)
  const gaps=openings.flatMap((x,i)=>openings.slice(i+1).filter(y=>y.head===x.head).map(y=>Math.hypot(x.x_m-y.x_m,x.y_m-y.y_m)-(x.diameter_m+y.diameter_m)/2))
  expect(Math.min(...gaps)).toBeGreaterThan(0)
 })
})
