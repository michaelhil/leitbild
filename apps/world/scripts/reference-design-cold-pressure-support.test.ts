import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileColdPressure,nativeColdPressureFrame,parseColdPressureSelection} from './reference-design-cold-pressure-support'
import {compileFuelCooling} from './reference-design-fuel-cooling'

const wiki=process.env.LEITBILD_REFERENCE_WIKI
const ownerTest=wiki?test:test.skip
ownerTest('actual cold pressure selection preserves finite hardware and route ownership',async()=>{
 const p=await compileFuelCooling(wiki!),text=await Bun.file(join(wiki!,'model/operating-pressure-support.md')).text(),
  route=await Bun.file(join(wiki!,'systems/primary-coolant/surge-route.md')).text(),
  selection=parseColdPressureSelection(text),d=compileColdPressure(text,route,p.network.water,p.barrel,
   p.primary.boronAtomsPerKg/p.primary.markerRatio,p.conditioning.liquidTemperature_K)
 expect(d.primary).toBe(p.network.water.findIndex(w=>w.id==='HOT.A'))
 expect(d.metals).toHaveLength(9)
 expect(d.route.liquidVolume_m3).toBeCloseTo(Math.PI*.3**2/4*16,12)
 expect(d.route.volumeMeanElevation_m).toBeCloseTo(3.000896016010998,12)
 expect(d.metals.filter(m=>m.kind==='rod').reduce((v,m)=>v+m.mass,0)).toBeCloseTo(1990.51310525,6)
 expect(d.metals.filter(m=>m.kind==='bottom'||m.kind==='top').map(m=>m.mass)).toEqual([5940,5940])
 expect(d.atomsPerMarker).toBe(p.primary.boronAtomsPerKg/p.primary.markerRatio)
 expect(d.route.exitLoss).toBe(1)
 expect(d.lineAmbientConductance).toBeGreaterThan(0)
 const frame=nativeColdPressureFrame(d)
 expect(frame.every(Number.isFinite)).toBe(true)
 expect(frame[0]).toBe(d.primary)
 expect(frame[1]).toBe(d.route.liquidVolume_m3)
 expect(frame[6]).toBe(d.route.entryLoss+d.route.exitLoss)
 const changed=nativeColdPressureFrame({...d,route:{...d.route,exitLoss:2}})
 expect(changed[6]).toBe(frame[6]!+1)
 expect(changed.filter((v,i)=>v!==frame[i])).toHaveLength(1)
 expect(frame.at(-1)).toBe(d.selection.initialTemperature_K)
 expect(frame.at(-2)).toBe(p.conditioning.liquidTemperature_K)
 expect(d.selection.initialTemperature_K).toBe(300)
 const changedPreparation=nativeColdPressureFrame({...d,surgeLiquidTemperature_K:298.15})
 expect(changedPreparation.filter((v,i)=>v!==frame[i])).toEqual([298.15])
 // Native PZR metal applicability must remain cold even when the shared
 // 304 coefficients are valid up to 1600 K (or a broader future domain).
 expect(frame[43]).toBe(d.selection.minimumTemperature_K)
 expect(frame[44]).toBe(d.selection.maximumTemperature_K)
 expect(nativeColdPressureFrame(compileColdPressure(text,route,p.network.water,
  {...p.barrel,maximum_k:2000},1,p.conditioning.liquidTemperature_K))).toEqual(frame)
 expect(()=>nativeColdPressureFrame({...d,lineAmbientConductance:NaN})).toThrow()
 expect(()=>compileColdPressure(text,route,p.network.water,{...p.barrel,minimum_k:301},1,293.15)).toThrow('domain')
 for(const caloric of [{...p.barrel,minimum_k:295},{...p.barrel,maximum_k:325}])
  expect(()=>compileColdPressure(text,route,p.network.water,caloric,1,293.15)).toThrow('domain')
 expect(()=>parseColdPressureSelection(text+text)).toThrow()
 expect(()=>parseColdPressureSelection(text.replace('"initialLevel_m": 4','"initialLevel_m": 7'))).toThrow()
 expect(()=>parseColdPressureSelection(text.replace('"initialLevel_m": 4','"initialLevel_m": 4, "undeclared": 1'))).toThrow()
 expect(()=>compileColdPressure(text,route,p.network.water.filter(w=>w.id!==selection.primaryCell),p.barrel,1,293.15)).toThrow()
 expect(()=>compileColdPressure(text,route,p.network.water,p.barrel,0,293.15)).toThrow()
 for(const temperature of [NaN,selection.minimumTemperature_K-1,selection.maximumTemperature_K+1])
  expect(()=>compileColdPressure(text,route,p.network.water,p.barrel,1,temperature)).toThrow('domain')
},60_000)
