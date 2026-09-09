import { expect,test } from 'bun:test'
import { parseFuelTransient } from './reference-design-fuel-transient.ts'
const input:ReturnType<typeof parseFuelTransient>={fuelIntervals:[8,16,32],maxSteps_s:[.2,.1,.05],hold_s:2,reducedPowerFraction:.9,reducedDuration_s:20,recovery_s:20}
const doc=(x:unknown)=>'```reference-fuel-transient\n'+JSON.stringify(x)+'\n```\n'
test('bounded radial experiment cannot silently change declared acceptance grid or history',()=>{
  expect(parseFuelTransient(doc(input))).toEqual(input)
  for(const text of ['',doc(input)+doc(input),doc({...input,extra:true}),doc({...input,reducedPowerFraction:0}),doc({...input,hold_s:0}),doc({...input,fuelIntervals:[16,8,32]})])
    expect(()=>parseFuelTransient(text)).toThrow()
})
