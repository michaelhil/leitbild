import {expect,test} from 'bun:test'
import {parsePressureChannel,parsePressureProtection,nativePressureChannelFields,nativePressureProtectionFields} from './reference-design-pressure-observation'
const channel='```reference-pzr-pressure-channel\n{"lag_s":0.2,"min_pa":0,"max_pa":20000000,"quantum_pa":1000,"sample_s":0.1,"transport_s":0.1}\n```'
const protection='```reference-pzr-pressure-protection\n{"maximum_age_s":0.3,"recovery_s":1,"high_pa":15500000,"high_qualification_s":0.2,"low_pa":13000000,"low_qualification_s":0.5,"unavailable_qualification_s":1,"reset_low_pa":13500000,"reset_high_pa":15200000,"reset_qualification_s":5}\n```'
test('pressure evidence owns explicit complete channel and decision inputs',()=>{
 expect(nativePressureChannelFields(parsePressureChannel(channel))).toEqual([.2,0,20e6,1000,.1,.1])
 expect(nativePressureProtectionFields(parsePressureProtection(protection))).toEqual([.3,1,15.5e6,.2,13e6,.5,1,13.5e6,15.2e6,5])
 for(const bad of ['',channel+channel,channel.replace('"transport_s":0.1','"transport_s":0.2'),
  channel.replace('"lag_s":0.2','"lag_s":0'),channel.replace('"min_pa":0','"min_pa":21000000'),
  channel.replace('"quantum_pa":1000','"quantum_pa":1000,"invented":1')])expect(()=>parsePressureChannel(bad)).toThrow()
 for(const bad of ['',protection+protection,protection.replace('"reset_high_pa":15200000','"reset_high_pa":16000000'),
  protection.replace('"recovery_s":1','"recovery_s":0'),protection.replace('"maximum_age_s":0.3','"extra":0.3')])expect(()=>parsePressureProtection(bad)).toThrow()
})
