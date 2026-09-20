import {test,expect} from 'bun:test'
import {hotWorkComparison} from './reference-design-hot-service-mixture'
import {pressureExchange,streamLoss,backflowBrake} from './reference-design-service-pump-signed'

test('effective work admission is signed, with exact zero limit and explicit failure',()=>{
 expect(hotWorkComparison(-475.917851,-475.685274).admitted).toBe(true)
 expect(hotWorkComparison(100.2,100).admitted).toBe(false)
 expect(hotWorkComparison(-100.2,-100).admitted).toBe(false)
 expect(hotWorkComparison(0,0)).toEqual({defect:0,relative:null,admitted:true})
 expect(hotWorkComparison(1e-9,0).admitted).toBe(false)
 expect(()=>hotWorkComparison(NaN,1)).toThrow()
})
test('gas-bound retained case suppresses exchange, not passive material passage',()=>{
 expect(pressureExchange(15e6,.002,.1,.2,-2,0)).toBe(0)
 expect(streamLoss(22000,.002,0,60,300,-2)).toEqual({torque:0,power:0})
 expect(backflowBrake(-2,60,-10)).toEqual({torque:20,power:1200})
 expect(backflowBrake(-2,-60,10).power===0).toBe(true)
 expect(()=>pressureExchange(15e6,1,.1,.2,-2,1.1)).toThrow()
})
