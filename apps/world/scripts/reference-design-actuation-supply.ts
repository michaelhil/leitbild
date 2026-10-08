/** Compile the selected finite ACT.A support cut. Physical advancement belongs
 * to the exact native provider, not to the compiler or a second plant model. */
import {z} from 'zod'
import {configurationBlock} from './reference-design-source-laws'
import {parseDcBasis} from './reference-design-dc-sequence'
import type {compilePrhrCooling} from './reference-design-prhr-cooling'
const change=z.boolean().optional()
const event=z.object({at_s:z.number().finite().min(0).lt(300),chargerAvailable:change,
 batteryAvailable:change,outputHealthy:change,
 distributionCommands:z.array(z.enum(['open','reset','close'])).min(1).optional(),
 prhrCommand:z.enum(['open','close']).optional()}).strict().refine(e=>
 e.chargerAvailable!==undefined||e.batteryAvailable!==undefined||e.outputHealthy!==undefined
 ||e.distributionCommands!==undefined||e.prhrCommand!==undefined,'Empty ACT boundary')
const selection=z.object({supply:z.literal('LD01.DC.ACT.A'),initialUsableEnergy_J:z.number().finite().nonnegative(),
 initialChargerAvailable:z.boolean(),initialBatteryAvailable:z.boolean(),initialOutputHealthy:z.boolean(),
 initialOutputClosed:z.boolean(),remainingConsumerDuty:z.literal('reference-continuous-minus-prhr-hold'),
 events:z.array(event)}).strict().refine(s=>s.events.every((e,i)=>i===0||
 e.at_s-s.events[i-1]!.at_s>4*Number.EPSILON*Math.max(1,Math.abs(e.at_s),Math.abs(s.events[i-1]!.at_s))),
 'ACT boundaries must be distinct and increasing')
export function compileActuationSupply(document:string,prhr:ReturnType<typeof compilePrhrCooling>){
 const basis=parseDcBasis(document),prep=selection.parse(configurationBlock(document,'reference-cold-act-a-connection')),
  capacity_J=basis.usableEnergy_kWh*3.6e6,remainingDuty_W=basis.continuousDuty_W-prhr.actuator.hold_power_w
 if(prep.initialUsableEnergy_J>capacity_J)throw Error('ACT preparation exceeds finite usable capacity')
 if(remainingDuty_W<0)throw Error('PRHR holding duty exceeds selected ACT continuous load')
 return {basis,prep,capacity_J,remainingDuty_W,
  scope:'Exact finite ACT.A energy/support provider; actual PRHR work and DC losses join ROOM.A, other consumer work and AC input remain explicit boundaries; no whole-plant electrical or protection claim'}
}
export function nativeActuationSupplyFrame(p:ReturnType<typeof compileActuationSupply>|undefined):number[]{
 if(!p)return [0]
 const {basis:b,prep:s}=p,commands={open:0,reset:1,close:2},change=(v:boolean|undefined)=>v===undefined?-1:+v,
  fields=[1,p.capacity_J,b.continuousDuty_W,b.chargerLimit_W,b.outputLimit_W,b.chargeEfficiency,
   b.dischargeEfficiency,b.converterEfficiency,s.initialUsableEnergy_J,+s.initialChargerAvailable,
   +s.initialBatteryAvailable,+s.initialOutputHealthy,+s.initialOutputClosed,s.events.length]
 for(const e of s.events){const cs=e.distributionCommands??[]
  fields.push(e.at_s,change(e.chargerAvailable),change(e.batteryAvailable),change(e.outputHealthy),
   cs.length,...cs.map(c=>commands[c]),e.prhrCommand===undefined?-1:e.prhrCommand==='open'?0:1)}
 if(!fields.every(Number.isFinite))throw Error('Nonfinite native ACT frame')
 return fields
}
