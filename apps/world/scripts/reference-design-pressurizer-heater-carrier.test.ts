import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {assertCarrierGeometry,assertCarrierParents} from './reference-design-pressurizer-heater-carrier'
import {normalThermalPython} from './reference-design-pressurizer-normal-thermal'
import {normalPhasePython} from './reference-design-pressurizer-normal-phase'

test('carrier owns existing volume and can pay its one discharge loss',()=>{
  const delivery={upflowArea_m2:.5,returnArea_m2:4.5,circulationLossCoefficient:2} as Parameters<typeof assertCarrierGeometry>[0]
  const heater={heaterLength_m:1} as Parameters<typeof assertCarrierGeometry>[1]
  const pzr={area_m2:5,liquidVolume_m3:30} as Parameters<typeof assertCarrierGeometry>[2]
  expect(()=>assertCarrierGeometry(delivery,heater,pzr)).not.toThrow()
  expect(()=>assertCarrierGeometry({...delivery,returnArea_m2:5},heater,pzr)).toThrow()
  expect(()=>assertCarrierGeometry({...delivery,circulationLossCoefficient:.5},heater,pzr)).toThrow()
  expect(()=>assertCarrierGeometry(delivery,{...heater,heaterLength_m:7},pzr)).toThrow()
})
test('carrier refuses unrelated normal and phase references',()=>{
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),bytes='identified receipt'
  const thermal={calculationSha256:hash(normalThermalPython)}
  const phase={calculationSha256:hash(normalPhasePython),thermalReceiptSha256:hash(bytes)}
  expect(()=>assertCarrierParents(thermal,phase,bytes)).not.toThrow()
  expect(()=>assertCarrierParents({...thermal,calculationSha256:'wrong'},phase,bytes)).toThrow()
  expect(()=>assertCarrierParents(thermal,{...phase,calculationSha256:'wrong'},bytes)).toThrow()
  expect(()=>assertCarrierParents(thermal,phase,bytes+' changed')).toThrow()
})
