/** Compile the selected PZR channel and pressure-demand interface, not another
 * physical law or a general-purpose I&C configuration language. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'

const positive=z.number().finite().positive()
const channelSchema=z.object({lag_s:positive,min_pa:z.number().finite().nonnegative(),max_pa:positive,
 quantum_pa:positive,sample_s:positive,transport_s:positive}).strict().refine(v=>
 v.max_pa>v.min_pa&&v.quantum_pa<=v.max_pa-v.min_pa&&v.transport_s===v.sample_s,
 'Selected channel requires a valid span and equal acquisition/transport interval')
export function parsePressureChannel(document:string){
 return channelSchema.parse(configurationBlock(document,'reference-pzr-pressure-channel'))
}
export function nativePressureChannelFields(channel:ReturnType<typeof parsePressureChannel>){
 return [channel.lag_s,channel.min_pa,channel.max_pa,channel.quantum_pa,channel.sample_s,channel.transport_s]
}
const protectionSchema=z.object({maximum_age_s:positive,recovery_s:positive,high_pa:positive,
 high_qualification_s:positive,low_pa:positive,low_qualification_s:positive,
 unavailable_qualification_s:positive,reset_low_pa:positive,reset_high_pa:positive,
 reset_qualification_s:positive}).strict().refine(v=>v.low_pa<v.reset_low_pa&&
 v.reset_low_pa<v.reset_high_pa&&v.reset_high_pa<v.high_pa,'Pressure reset band must lie between trip thresholds')
export function parsePressureProtection(document:string){
 return protectionSchema.parse(configurationBlock(document,'reference-pzr-pressure-protection'))
}
export function nativePressureProtectionFields(s:ReturnType<typeof parsePressureProtection>){
 return [s.maximum_age_s,s.recovery_s,s.high_pa,s.high_qualification_s,s.low_pa,s.low_qualification_s,
  s.unavailable_qualification_s,s.reset_low_pa,s.reset_high_pa,s.reset_qualification_s]
}
