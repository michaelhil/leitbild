import {beforeAll,expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileFuelCooling} from './reference-design-fuel-cooling'
import {compileActuationSupply,nativeActuationSupplyFrame} from './reference-design-actuation-supply'
const wiki=process.env.LEITBILD_REFERENCE_WIKI,owned=wiki?test:test.skip
let p:Awaited<ReturnType<typeof compileFuelCooling>>,document:string
beforeAll(async()=>{if(!wiki)return
 p=await compileFuelCooling(wiki,{prhr:true})
 document=await Bun.file(join(wiki,'systems/electrical/dc-storage.md')).text()
})
owned('finite ACT compilation derives the remaining load instead of counting PRHR holding twice',()=>{
 const a=p.actuation!
 expect(a.capacity_J).toBe(57.6e6)
 expect(a.remainingDuty_W).toBe(1980)
 expect(a.prep.initialUsableEnergy_J).toBe(90000)
 expect(a.basis.continuousDuty_W).toBe(a.remainingDuty_W+p.prhr!.actuator.hold_power_w)
 expect(a.prep.events.map(e=>e.at_s)).toEqual([60,65,70,90])
 expect(a.prep.events[1]!.distributionCommands).toEqual(['reset','close'])
})
owned('strict ACT frame retains initial path state and ordered recovery commands',()=>{
 const f=nativeActuationSupplyFrame(p.actuation)
 expect(nativeActuationSupplyFrame(undefined)).toEqual([0])
 expect(f.slice(0,14)).toEqual([1,57.6e6,2000,10000,20000,.95,.95,.92,90000,0,1,1,1,4])
 expect(f.slice(14)).toEqual([60,1,-1,-1,0,-1,65,-1,-1,-1,2,1,2,-1,
  70,-1,-1,-1,0,1,90,-1,-1,-1,0,0])
})
owned('ACT preparation rejects ambiguous, over-capacity and duplicate-time selections',()=>{
 const compile=(s:string)=>compileActuationSupply(s,p.prhr!)
 expect(()=>compile(document.replace('"initialUsableEnergy_J":90000','"initialUsableEnergy_J":60000000'))).toThrow()
 expect(()=>compile(document.replace('"at_s":65','"at_s":60'))).toThrow()
 expect(()=>compile(document.replace('"at_s":90','"at_s":300'))).toThrow()
 expect(()=>compile(document.replace('"chargerAvailable":true','"chargerAvailable":true,"unknown":1'))).toThrow()
 expect(()=>compile(document.replace('"distributionCommands":["reset","close"]','"distributionCommands":[]'))).toThrow()
 const changed=compile(document.replace('"initialUsableEnergy_J":90000','"initialUsableEnergy_J":12345'))
 expect(changed.prep.initialUsableEnergy_J).toBe(12345)
})
