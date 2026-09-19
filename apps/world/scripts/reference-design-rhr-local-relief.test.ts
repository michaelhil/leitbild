import { expect, test } from 'bun:test'
import { advanceReliefLift, localReliefDemand, parseRhrLocalRelief } from './reference-design-rhr-local-relief'

const values = {openingDifferential_MPa:1.55,reseatDifferential_MPa:1.45,maximumCdA_m2:.0005,stroke_s:.05,
  strokeSensitivity_s:[.025,.05,.1],couponInitialPressure_MPa:1.6,couponTemperatures_C:[40,150],
  receiverPressures_MPa:[.101325,.5],couponDuration_s:2}
const document = (v:unknown) => '```reference-rhr-local-relief\n'+JSON.stringify(v)+'\n```'
test('local mechanical differential hysteresis preserves state and finite closure', () => {
  const b=parseRhrLocalRelief(document(values))
  expect(localReliefDemand(1.55,false,b)).toBe(true)
  expect(localReliefDemand(1.5,true,b)).toBe(true)
  expect(localReliefDemand(1.5,false,b)).toBe(false)
  expect(localReliefDemand(1.45,true,b)).toBe(false)
  expect(advanceReliefLift(.4,false,0,.05)).toBe(.4)
  expect(advanceReliefLift(.4,false,.01,.05)).toBeCloseTo(.2)
  expect(advanceReliefLift(.5,false,.024,.05)).toBeGreaterThan(0)
  expect(advanceReliefLift(.5,false,.025,.05)).toBe(0)
  expect(advanceReliefLift(.4,false,.4*.05,.05)).toBe(0)
  expect(advanceReliefLift(.4,true,.03,.05)).toBe(1)
})
test('receiver backpressure changes absolute opening, not material inventory or a reset', () => {
  const b=parseRhrLocalRelief(document(values))
  expect(localReliefDemand(1.8-.101325,false,b)).toBe(true)
  expect(localReliefDemand(1.8-.5,false,b)).toBe(false)
  expect(.5+b.openingDifferential_MPa).toBeGreaterThan(2)
  const copy=JSON.parse(JSON.stringify({lift:.2,released:true}))
  expect(advanceReliefLift(copy.lift,copy.released,.01,.05)).toBeCloseTo(.4)
  expect(copy).toEqual({lift:.2,released:true})
})
test('strict owner and mechanical admission reject ambiguous or invalid state', () => {
  expect(()=>parseRhrLocalRelief(document({...values,unowned:true}))).toThrow()
  expect(()=>parseRhrLocalRelief(document(values)+document(values))).toThrow()
  expect(()=>parseRhrLocalRelief(document({...values,reseatDifferential_MPa:1.6}))).toThrow()
  expect(()=>advanceReliefLift(-.1,false,.01,.05)).toThrow()
  expect(()=>advanceReliefLift(.1,false,-1,.05)).toThrow()
  expect(()=>localReliefDemand(NaN,false,values)).toThrow()
})
