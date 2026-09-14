import {describe,test,expect} from 'bun:test'
import {parsePrhrContact,prhrImmersedCircumference,prhrContactPartition,prhrCondensationDemand,prhrLiquidMixingAvailability} from './reference-design-prhr-phase-contact'
const b={gasSensible_W_m2K:5,condensationVelocity_m_s:.01,effectiveEmissivity:.3,bankFactor:.5}
describe('PRHR effective contact selection',()=>{
 test('one authored basis and no accidental keys',()=>{
  expect(parsePrhrContact('```reference-prhr-phase-contact\n'+JSON.stringify(b)+'\n```')).toEqual(b)
  expect(()=>parsePrhrContact('')).toThrow()
  expect(()=>parsePrhrContact('```reference-prhr-phase-contact\n'+JSON.stringify({...b,extra:1})+'\n```')).toThrow()
 })
 test('actual circumference differs from submerged cross-section area',()=>{
  expect(prhrImmersedCircumference(0,0,1)).toBe(.5)
  expect(prhrImmersedCircumference(-2,0,1)).toBe(0)
  expect(prhrImmersedCircumference(2,0,1)).toBe(1)
  expect(prhrImmersedCircumference(.5,0,1)).toBeCloseTo(2/3,14)
  expect(prhrImmersedCircumference(.2,0,1)+prhrImmersedCircumference(-.2,0,1)).toBeCloseTo(1,14)
 })
 test('disjoint actual areas preserve wet/dry and effective internal phase endpoints',()=>{
  for(const fraction of [0,.000001,.25,.5,.999999,1]){
   const q=prhrContactPartition(5,fraction,400,-20)
   expect(q.liquid_W+q.gas_W).toBeCloseTo(5*(fraction*400-(1-fraction)*20),11)
  }
  expect(prhrContactPartition(0,.5,400,-20)).toEqual({liquid_W:0,gas_W:-0})
  expect(()=>prhrContactPartition(1,1.1,1,1)).toThrow()
 })
 test('condensation needs actual available vapor and positive dewpoint density drive',()=>{
  expect(prhrCondensationDemand(b,0,0,0,0).equivalentCondensationDemand_kg_m2s).toBe(0)
  expect(prhrCondensationDemand(b,1,2,2e6,4e5).heatToSteel_W_m2).toBe(0)
  const q=prhrCondensationDemand(b,2,1,2.7e6,4e5)
  expect(q.equivalentCondensationDemand_kg_m2s).toBe(.01)
  expect(q.heatToSteel_W_m2).toBe(23000)
  expect(()=>prhrCondensationDemand(b,2,1,0,1)).toThrow()
 })
 test('external transfer keeps source, steel, condensate and descent energy distinct',()=>{
  const m=.01,hv=2.7e6,hl=4e5,z=13,level=12,g=9.80665
  const donor=m*(hv+g*z),steel=m*(hv-hl),pool=m*(hl+g*level)+m*g*(z-level)
  expect(donor-steel-pool).toBeCloseTo(0,10)
 })
 test('extra liquid mixing vanishes at either absent phase and preserves pair exchange',()=>{
  expect(prhrLiquidMixingAvailability(1,1)).toBe(1)
  expect(prhrLiquidMixingAvailability(0,1)).toBe(0)
  expect(prhrLiquidMixingAvailability(.3,0)).toBe(0)
  const weight=prhrLiquidMixingAvailability(.5,.2),heat=weight*200,solute=weight*.01
  expect(weight).toBe(.1)
  expect(heat-heat).toBe(0)
  expect(solute-solute).toBe(0)
  expect(()=>prhrLiquidMixingAvailability(-1,1)).toThrow()
 })
})
