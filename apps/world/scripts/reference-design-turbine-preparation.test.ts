import { expect,test } from 'bun:test'
import { casingExchange,parseTurbinePreparation } from './reference-design-turbine-preparation'
const basis={hpCapacity_J_K:30000000,lpCapacity_J_K:150000000,hpContact_W_K:50000,lpContact_W_K:100000,
  roomContact_W_K:100,drainCdA_m2:.0005,drainStroke_s:2,drainMotion_W:100,warmDifference_K:30,
  warmDuration_s:30,maximumLiquidFraction:.01}
test('one strict casing record rejects duplicate and magic warming',()=>{
  const owner='```reference-turbine-preparation\n'+JSON.stringify(basis)+'\n```\n'
  expect(parseTurbinePreparation(owner)).toEqual(basis)
  expect(()=>parseTurbinePreparation(owner+owner)).toThrow()
  expect(()=>parseTurbinePreparation(owner.replace('"warmDuration_s":30','"warmDuration_s":30,"warmed":true'))).toThrow()
})
test('body, real fluid and room share signed reciprocal heat',()=>{
  for(const body of [313,400,550]) {
    const x=casingExchange(body,400,303,50000,100)
    expect(x.fluid_W+x.body_W+x.room_W).toBe(0)
  }
  expect(casingExchange(313,400,303,50000,100).fluid_W).toBeLessThan(0)
  expect(casingExchange(550,400,303,50000,100).fluid_W).toBeGreaterThan(0)
  expect(()=>casingExchange(313,0,303,50000,100)).toThrow()
})
