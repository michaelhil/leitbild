import { expect,test } from 'bun:test'
import { dryAirFlux,parseGland } from './reference-design-gland'
test('dry air nozzle has actual zero and finite choking limit',()=>{
  expect(dryAirFlux(101325,313.15,101325)).toBe(0)
  expect(dryAirFlux(101325,313.15,10000)).toBe(dryAirFlux(101325,313.15,20000))
  expect(dryAirFlux(101325,313.15,90000)).toBeLessThan(dryAirFlux(101325,313.15,10000))
  expect(()=>dryAirFlux(10000,300,101325)).toThrow()
})
test('gland record has one exact physical input, no dynamic ready flag',()=>{
  const b={volume_m3:1,area_m2:1,floor_m:5,outerCdA_m2:.0003,innerCdA_m2:.0003,supplyCdA_m2:.0002,
    drainCdA_m2:.0001,targetPressure_Pa:110000,metalCapacity_J_K:1000000,fluidContact_W_K:1000,roomContact_W_K:100}
  const owner='```reference-gland\n'+JSON.stringify(b)+'\n```\n'
  expect(parseGland(owner)).toEqual(b)
  expect(()=>parseGland(owner+owner)).toThrow()
  expect(()=>parseGland(owner.replace('"volume_m3":1','"ready":true,"volume_m3":1'))).toThrow()
})
