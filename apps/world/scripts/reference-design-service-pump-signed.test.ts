import {describe,test,expect} from 'bun:test'
import {parseSelection,pressureExchange,exchangeTorque,streamLoss,backflowBrake} from './reference-design-service-pump-signed'
import {motorBudget} from './reference-design-rhr-signed-pump'
const record={crossCoefficient:.1,crossSensitivity:[0,.1,.2],rpm:3000,leakAreaFraction:.01}
const text=(x:unknown)=>'```reference-service-pump-signed\n'+JSON.stringify(x)+'\n```'
describe('Selected signed HP pump boundaries',()=>{
 test('strict record, no accidental defaults',()=>{
  expect(parseSelection(text(record))).toEqual(record)
  expect(()=>parseSelection(text({...record,extra:1}))).toThrow()
  expect(()=>parseSelection(text({...record,crossCoefficient:.25}))).toThrow()
  expect(()=>parseSelection(text({...record,leakAreaFraction:0}))).toThrow()
  expect(()=>parseSelection(text({...record,crossSensitivity:[.3]}))).toThrow()
  expect(()=>parseSelection('')).toThrow()
 })
 test('continuous retained-case head and disabled-pressure limit',()=>{
  expect(pressureExchange(100,1,.1,1,0,1)).toBe(125)
  expect(pressureExchange(100,1,.1,1,1,1)).toBeCloseTo(115)
  expect(pressureExchange(100,1,.1,1,-1,1)).toBeCloseTo(115)
  expect(pressureExchange(100,1,.1,1,1,0)).toBe(0)
  expect(pressureExchange(100,1,.1,0,-1,1)).toBeCloseTo(0)
  expect(Math.abs(pressureExchange(100,1,.1,1,1e-8,1)-pressureExchange(100,1,.1,1,-1e-8,1))).toBeLessThan(1e-6)
 })
 test('reverse flow starts reverse rotation, including either zero-speed approach',()=>{
  for(const n of [-1e-8,0,1e-8]){
   expect(exchangeTorque(100,1,.1,n,-1,1,-2,100,.001)).toBeGreaterThan(0)
   expect(exchangeTorque(100,1,.1,n,1,1,2,100,.001)).toBeLessThan(0)
  }
 })
 test('rotor heat resists either speed and has continuous zero torque',()=>{
  for(const omega of [-100,-1e-8,0,1e-8,100]){
   const x=streamLoss(1000,1,.5,omega,100,-2)
   expect(x.power).toBeGreaterThanOrEqual(0)
   expect(x.torque*omega).toBe(x.power)
  }
  expect(streamLoss(1000,1,0,100,100,2).power).toBe(0)
  expect(streamLoss(1000,1,1,100,100,0).power).toBe(0)
  expect(streamLoss(1000,1,1,0,100,2).torque).toBe(0)
 })
 test('ideal drive brakes negative rotation without electrical export',()=>{
  for(const omega of [-100,0,100]){
   const x=motorBudget(10,omega,.9)
   expect(x.electric).toBeGreaterThanOrEqual(0)
   expect(x.heat).toBeGreaterThanOrEqual(0)
   expect(x.electric-x.shaft).toBeCloseTo(x.heat)
  }
 })
 test('running reverse-flow braking debits rotor and heats stream once',()=>{
  for(const exchange of [-20,-1e-9,0,1e-9,20]){
   const b=backflowBrake(-1,100,exchange)
   expect(exchange+b.torque).toBeCloseTo(Math.abs(exchange))
   expect(b.power).toBe(b.torque*100)
  }
  expect(backflowBrake(-1,-100,20).power).toBeCloseTo(0)
  expect(backflowBrake(1,100,20).power).toBe(0)
 })
})
