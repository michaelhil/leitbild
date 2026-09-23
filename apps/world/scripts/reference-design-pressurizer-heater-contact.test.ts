import {describe,expect,test} from 'bun:test'
import {heaterContactAreas} from './reference-design-pressurizer-heater-contact'
import {heaterBankGeometry} from './reference-design-pressurizer-heater-banks'

describe('fixed PZR steel with complementary fluid contact',()=>{
 test('contact and exposure sum to the actual bank area without resizing metal',()=>{
  for(const height of [0,.5,1,2,3,6,12])for(const fraction of [0,.5,1]){
   const contact=heaterContactAreas(height,fraction),geo=heaterBankGeometry(height)
   for(const name of ['normal','backup'] as const){
    expect(contact[name]!.wet_m2+contact[name]!.gas_m2).toBeCloseTo(geo.banks[name].fullSideArea_m2,10)
    expect(contact[name]!.steelMass_kg).toBe(geo.banks[name].steelMass_kg)
   }
  }
 })
 test('empty liquid retains all metal and exposes both banks',()=>{
  const c=heaterContactAreas(0,1)
  expect(c.normal!.wet_m2).toBe(0);expect(c.backup!.wet_m2).toBe(0)
  expect(c.normal!.gas_m2).toBeGreaterThan(0);expect(c.backup!.gas_m2).toBeGreaterThan(0)
 })
 test('invalid physical fraction does not silently clamp',()=>{
  for(const x of [-.01,1.01,NaN])expect(()=>heaterContactAreas(1,x)).toThrow()
 })
})
