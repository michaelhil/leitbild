import {expect,test} from 'bun:test'
import {gasSourceVolumes} from './reference-design-secondary-gas'
test('Source volume is constituent-specific and reduces to pure steam',()=>{
 const pure=gasSourceVolumes(2,1e5,0,400)
 expect(pure.steam).toBe(.5)
 const mixed=gasSourceVolumes(2,1e5,1e5,400)
 expect(mixed.steam).toBeCloseTo(1/3,12)
 expect(mixed.air).toBeCloseTo(287*400/3e5,12)
 expect(mixed.nitrogen).toBeCloseTo(296.8*400/3e5,12)
 expect(mixed.air).not.toBe(mixed.nitrogen)
})
test('Absent or inadmissible derivative state is explicit',()=>{
 expect(()=>gasSourceVolumes(0,1e5,0,400)).toThrow()
 expect(()=>gasSourceVolumes(2,-1,1e5,400)).toThrow()
 expect(()=>gasSourceVolumes(2,1e5,1e5,NaN)).toThrow()
 expect(gasSourceVolumes(0,461.52*400,1e5,400).steam).toBeCloseTo(1.84608,12)
})
