import {expect,test} from 'bun:test'
import {gasConstants,mixtureWorkAdmitted} from './reference-design-service-pump-mixture'
test('Effective work admission is finite, relative, and does not conceal sign',()=>{
 expect(mixtureWorkAdmitted(1000.5,1000)).toBe(true)
 expect(mixtureWorkAdmitted(1002,1000)).toBe(false)
 expect(mixtureWorkAdmitted(-1000,-1000)).toBe(false)
 expect(mixtureWorkAdmitted(NaN,1000)).toBe(false)
})
test('Air and nitrogen retain distinct caloric identity',()=>{
 expect(gasConstants.air.R+gasConstants.air.cv).toBe(1005)
 expect(gasConstants.nitrogen.R+gasConstants.nitrogen.cv).toBe(1038.8)
 expect(gasConstants.air).not.toEqual(gasConstants.nitrogen)
})
