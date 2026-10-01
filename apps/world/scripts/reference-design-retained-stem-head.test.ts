import {describe,it,expect} from 'bun:test'
import {retainedStemGeometry} from './reference-design-retained-stem-head'

const a={shoulderBottom_m:8.49,stubLength_m:.055,lugWidth_m:.003,lugOuterRadius_m:.008,
 lugBottom_m:2.45,lugHeight_m:.01,shoulderDiameter_m:.02,shoulderHeight_m:.01},
 c={stemDiameter_m:.012,collarBottoms_m:[8.10,8.40],collarHeight_m:.05,
 spiderBottom_m:2.4,spiderHeight_m:.1,stemLength_m:6,clusters:52 as const,
 steelDensity_kg_m3:7920,headBottom_m:4,housingTop_m:8,neckTop_m:13.6}
describe('captured stems and disjoint head-water geometry',()=>{
 it('retains the actual finite shoulder fall and FA clearance',()=>{
  const q=retainedStemGeometry(a,c)
  expect(q.fall_m).toBeCloseTo(.04,12)
  expect(q.bottom_m).toBeCloseTo(2.405,12)
  expect(q.top_m).toBeCloseTo(8.46,12)
  expect(q.mass_kg).toBeCloseTo(282.9073046045054,8)
 })
 it('counts added lug/shoulder metal once, not the keyed envelope',()=>{
  const q=retainedStemGeometry(a,c),R=.006,
   V=52*(Math.PI*R**2*6.055+2*.003*(.008-R)*.01+Math.PI*(.01**2-R**2)*.01)
  expect(q.volume_m3).toBeCloseTo(V,14)
  expect(q.pieces[1]!.lo_m).toBeCloseTo(2.41,12)
  expect(q.pieces[2]!.lo_m).toBeCloseTo(8.45,12)
 })
 it('does not change main-housing water and only repartitions actual neck solids',()=>{
  const q=retainedStemGeometry(a,c)
  expect(q.housingMainWaterDelta_m3).toBeCloseTo(0,14)
  const expected=52*(Math.PI*.006**2*.04-Math.PI*(.01**2-.006**2)*.01)
  expect(q.housingNeckWaterDelta_m3).toBeCloseTo(expected,14)
  expect(q.housingNeckWaterDelta_m3).toBeGreaterThan(0)
 })
 it('rejects overlap, impossible contact and nonfinite source geometry',()=>{
  expect(()=>retainedStemGeometry({...a,shoulderBottom_m:8.40},c)).toThrow()
  expect(()=>retainedStemGeometry({...a,stubLength_m:.2},c)).toThrow()
  expect(()=>retainedStemGeometry({...a,shoulderDiameter_m:.01},c)).toThrow()
  expect(()=>retainedStemGeometry(a,{...c,neckTop_m:7})).toThrow()
  expect(()=>retainedStemGeometry(a,{...c,steelDensity_kg_m3:NaN})).toThrow()
 })
})
