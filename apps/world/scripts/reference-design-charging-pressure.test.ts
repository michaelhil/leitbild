import {expect,test} from 'bun:test'
import {parseChargingPressure,chargingReliefDemand} from './reference-design-charging-pressure'
import {advanceReliefLift} from './reference-design-rhr-local-relief'
const b={bodyResidence_s:.05,equipmentPressure_MPa:22,equipmentTemperature_C:350,openingDifferential_MPa:18,
 reseatDifferential_MPa:17,maximumCdA_m2:.00005,stroke_s:.05,receiverPressures_MPa:[.101325,1],
 retainedHotPressure_MPa:15.2,retainedHotTemperature_C:290}
const document=(value:unknown)=>'```reference-charging-pressure\n'+JSON.stringify(value)+'\n```'
test('charging relief is differential, retained and mechanically finite',()=>{
 const parsed=parseChargingPressure(document(b))
 expect(chargingReliefDemand(18,false,parsed)).toBe(true)
 expect(chargingReliefDemand(17,true,parsed)).toBe(false)
 expect(chargingReliefDemand(17.5,true,parsed)).toBe(true)
 expect(chargingReliefDemand(17.5,false,parsed)).toBe(false)
 expect(chargingReliefDemand(18.5-.101325,false,parsed)).toBe(true)
 expect(chargingReliefDemand(18.5-1,false,parsed)).toBe(false)
 expect(advanceReliefLift(.5,false,.024,b.stroke_s)).toBeGreaterThan(0)
 expect(advanceReliefLift(.5,false,.025,b.stroke_s)).toBe(0)
 expect(advanceReliefLift(0,true,0,b.stroke_s)).toBe(0)
})
test('charging pressure record rejects ambiguous and invalid selections',()=>{
 expect(()=>parseChargingPressure(document({...b,unowned:true}))).toThrow()
 expect(()=>parseChargingPressure(document({...b,reseatDifferential_MPa:19}))).toThrow()
 expect(()=>parseChargingPressure(document({...b,equipmentPressure_MPa:15}))).toThrow()
 expect(()=>parseChargingPressure(document(b)+document(b))).toThrow()
 expect(()=>chargingReliefDemand(NaN,false,b)).toThrow()
})
