import {describe,test,expect} from 'bun:test'
import {heaterBankBasis as b,heaterBankGeometry,heaterPacking,heaterUpflowSection} from './reference-design-pressurizer-heater-banks'

describe('authored PZR heater hardware, not thermal/carrier qualification',()=>{
 test('both actual banks fit the one existing upflow cross section',()=>{
  const p=heaterPacking()
  expect(p.rods.filter(r=>r.bank==='normal')).toHaveLength(32)
  expect(p.rods.filter(r=>r.bank==='backup')).toHaveLength(256)
  expect(p.minimumWallClearance_m).toBeGreaterThan(0)
  expect(p.minimumRodClearance_m).toBeGreaterThan(0)
 })
 test('fixed metal displaces fluid even when the region is dry',()=>{
  const full=heaterBankGeometry(6)
  for(const h of [0,.5,1,2,3,6,12]){
   const g=heaterBankGeometry(h)
   expect(g.totalSolid_m3).toBeCloseTo(.08*Math.PI,12)
   expect(g.totalSteelMass_kg).toBeCloseTo(full.totalSteelMass_kg,10)
   expect(g.upflowFreeEnvelope_m3+g.returnFreeEnvelope_m3+g.upperFreeEnvelope_m3+g.totalSolid_m3).toBeCloseTo(60,12)
   expect(Math.min(g.upflowFreeEnvelope_m3,g.returnFreeEnvelope_m3,g.upperFreeEnvelope_m3)).toBeGreaterThanOrEqual(0)
   for(const name of ['normal','backup'] as const){
    const bank=g.banks[name]
    expect(bank.submergedSolid_m3+bank.exposedSolid_m3).toBeCloseTo(bank.solidVolume_m3,12)
    expect(bank.wetSideArea_m2+bank.drySideArea_m2).toBeCloseTo(bank.fullSideArea_m2,12)
   }
  }
 })
 test('partial immersion uses each physical span, not a power or LT fraction',()=>{
  const g=heaterBankGeometry(2)
  expect(g.banks.normal.wetSideArea_m2).toBeCloseTo(g.banks.normal.fullSideArea_m2,12)
  expect(g.banks.backup.wetSideArea_m2/g.banks.backup.fullSideArea_m2).toBeCloseTo(2/3,12)
  expect(g.banks.backup.top_m).toBe(9.5)
  expect(heaterBankGeometry(3).banks.backup.drySideArea_m2).toBe(0)
 })
 test('surface crossings preserve volume and use the matching section derivative',()=>{
  for(const h of [.5,2,4]){
   const step=1e-6,a=heaterBankGeometry(h-step),c=heaterBankGeometry(h+step)
   expect((c.upflowFreeEnvelope_m3-a.upflowFreeEnvelope_m3)/(2*step)).toBeCloseTo(heaterUpflowSection(h),8)
  }
  for(const h of [1,3])expect(Math.abs(heaterBankGeometry(h+1e-8).upflowFreeEnvelope_m3-heaterBankGeometry(h-1e-8).upflowFreeEnvelope_m3)).toBeLessThan(1.1e-8)
 })
 test('backup uses the same electrical surface rating, not a fitted fluid duty',()=>{
  const g=heaterBankGeometry(6)
  expect(b.normal.capacity_W+b.backup.capacity_W).toBe(3e6)
  expect(g.banks.backup.ratedSurfacePower_W_m2).toBeCloseTo(g.banks.normal.ratedSurfacePower_W_m2,9)
  expect(g.banks.backup.steelMass_kg/g.banks.normal.steelMass_kg).toBeCloseTo(24,12)
 })
 test('outside geometry is rejected without altering surface or inventory',()=>{
  for(const h of [-1,12.1,NaN,Infinity]){
   expect(()=>heaterBankGeometry(h)).toThrow()
   expect(()=>heaterUpflowSection(h)).toThrow()
  }
 })
})
