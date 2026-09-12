import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {assertDeliveryArea,assertDeliveryParentIds,parseNormalDelivery} from './reference-design-pressurizer-normal-delivery'
import {normalThermalPython} from './reference-design-pressurizer-normal-thermal'

const selected={tips:8,tipBore_m:.002,tipWaterFlow_m3_s:1/60000,referenceDifferential_Pa:200000,manualConductanceFraction:.01,effectiveDiameterFactor:2,upflowArea_m2:.5,returnArea_m2:4.5,circulationLossCoefficient:2,bubbleDiameter_m:.0005}
const block=(value:unknown)=>'```reference-pressurizer-normal-delivery\n'+JSON.stringify(value)+'\n```\n'
test('normal hardware inputs and finite carrier partition reject unsupported declarations',()=>{
  expect(parseNormalDelivery(block(selected))).toEqual(selected)
  expect(()=>parseNormalDelivery('')).toThrow()
  expect(()=>parseNormalDelivery(block(selected)+block(selected))).toThrow()
  for(const changed of [{tips:1},{tips:2.5},{tipBore_m:0},{effectiveDiameterFactor:0},{manualConductanceFraction:1.1},{imposedEscape_kg_s:.04}])
    expect(()=>parseNormalDelivery(block({...selected,...changed}))).toThrow()
  expect(()=>assertDeliveryArea(selected,5)).not.toThrow()
  expect(()=>assertDeliveryArea({...selected,returnArea_m2:5},5)).toThrow()
  expect(()=>assertDeliveryArea(selected,NaN)).toThrow()
})
test('parent identities are mandatory and historical thermal calculation bytes remain identical',()=>{
  const receipt={sourceSha256:'s',calculationSha256:'c',inputSha256:'i'}
  const parents={tee:receipt,primary:receipt}
  expect(()=>assertDeliveryParentIds(parents,receipt,receipt)).not.toThrow()
  for(const key of Object.keys(receipt))expect(()=>assertDeliveryParentIds(parents,{...receipt,[key]:'wrong'},receipt)).toThrow()
  expect(()=>assertDeliveryParentIds({},receipt,receipt)).toThrow()
  expect(createHash('sha256').update(normalThermalPython).digest('hex')).toBe('95d9fa5262887f80296463f854195f23377d81a18052e7d1dd0706bb49b52d5b')
})
