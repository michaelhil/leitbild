import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {compileColdPressure,parseColdPressureSelection} from './reference-design-cold-pressure-support'
import {compileFuelCooling} from './reference-design-fuel-cooling'

const wiki=process.env.LEITBILD_REFERENCE_WIKI
const ownerTest=wiki?test:test.skip
ownerTest('actual cold pressure selection preserves finite hardware and route ownership',async()=>{
 const p=await compileFuelCooling(wiki!),text=await Bun.file(join(wiki!,'model/operating-pressure-support.md')).text(),
  route=await Bun.file(join(wiki!,'systems/primary-coolant/surge-route.md')).text(),
  selection=parseColdPressureSelection(text),d=compileColdPressure(text,route,p.network.water,p.barrel,
   p.primary.boronAtomsPerKg/p.primary.markerRatio)
 expect(d.primary).toBe(p.network.water.findIndex(w=>w.id==='HOT.A'))
 expect(d.metals).toHaveLength(9)
 expect(d.route.liquidVolume_m3).toBeCloseTo(Math.PI*.3**2/4*16,12)
 expect(d.route.volumeMeanElevation_m).toBeCloseTo(3.000896016010998,12)
 expect(d.metals.filter(m=>m.kind==='rod').reduce((v,m)=>v+m.mass,0)).toBeCloseTo(1990.51310525,6)
 expect(d.metals.filter(m=>m.kind==='bottom'||m.kind==='top').map(m=>m.mass)).toEqual([5940,5940])
 expect(d.atomsPerMarker).toBe(p.primary.boronAtomsPerKg/p.primary.markerRatio)
 expect(d.route.exitLoss).toBe(1)
 expect(()=>parseColdPressureSelection(text+text)).toThrow()
 expect(()=>parseColdPressureSelection(text.replace('"initialLevel_m": 4','"initialLevel_m": 7'))).toThrow()
 expect(()=>parseColdPressureSelection(text.replace('"initialLevel_m": 4','"initialLevel_m": 4, "undeclared": 1'))).toThrow()
 expect(()=>compileColdPressure(text,route,p.network.water.filter(w=>w.id!==selection.primaryCell),p.barrel,1)).toThrow()
 expect(()=>compileColdPressure(text,route,p.network.water,p.barrel,0)).toThrow()
},60_000)
