import {test,expect} from 'bun:test'
import {closingOpening,parseLetdownTrim} from './reference-design-letdown-trim'
const b={stages:4,inletPressure_MPa:15,outletPressure_MPa:.101325,nominalTemperature_C:40,nominalFlow_kg_s:5,nominalOpening:.7,
 hotTemperatures_C:[60,150,290],raisedBackpressure_MPa:.5,reverseDonorPressure_MPa:.3,reverseReceiverPressure_MPa:.1,
 reverseTemperature_C:40,regulatingSpeed_s:.1,isolationStroke_s:2,upstreamPressure_MPa:15.2,upstreamTemperature_C:290}
const doc=(value:unknown)=>'```reference-letdown-trim\n'+JSON.stringify(value)+'\n```'
test('closing demand retains actual finite opening',()=>{
 expect(closingOpening(1,.5,0)).toBe(1)
 expect(closingOpening(1,.5,1)).toBe(.5)
 expect(closingOpening(1,.5,2)).toBe(0)
 expect(closingOpening(.7,.1,2)).toBeCloseTo(.5,12)
 expect(closingOpening(.7,.1,7)).toBe(0)
 expect(()=>closingOpening(1,0,1)).toThrow()
})
test('trim record owns geometry and consistent calibration',()=>{
 expect(parseLetdownTrim(doc(b))).toEqual(b)
 expect(()=>parseLetdownTrim(doc({...b,stages:3}))).toThrow()
 expect(()=>parseLetdownTrim(doc({...b,raisedBackpressure_MPa:16}))).toThrow()
 expect(()=>parseLetdownTrim(doc({...b,nominalOpening:2}))).toThrow()
 expect(()=>parseLetdownTrim(doc(b)+doc(b))).toThrow()
})
