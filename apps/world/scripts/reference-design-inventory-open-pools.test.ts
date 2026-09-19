import {expect,test} from 'bun:test'
import {parseOpenPools,signedSpill} from './reference-design-inventory-open-pools'
const b={pressure_Pa:101325,gravity_m_s2:9.80665,tankArea_m2:5,tankFloor_m:.6,tankHeight_m:4,
 collectionArea_m2:20,collectionFloor_m:0,weirWidth_m:1,weirCoefficient:1.7,initialTemperature_C:40,
 initialReceiverVolume_m3:2,receiptPort_m:3,parcelMass_kg:100,nominalPressure_MPa:15,nominalTemperature_C:40,
 hotPressure_MPa:15.2,hotTemperature_C:290,boilEnergy_J:100000,dryMass_kg:1,tracer_kg_eq:.2}
const doc=(input:unknown)=>'```reference-inventory-open-pools\n'+JSON.stringify(input)+'\n```'
test('finite spill uses actual crest, backwater and donor density',()=>{
 const parsed=parseOpenPools(doc(b));const crest=4.6
 expect(signedSpill(crest,0,1000,500,parsed)).toBe(0)
 const forward=signedSpill(crest+.1,0,1000,500,parsed)
 expect(forward).toBeGreaterThan(0)
 expect(signedSpill(crest+.1,crest+.05,1000,500,parsed)).toBeLessThan(forward)
 expect(signedSpill(crest+.1,crest+.1,1000,500,parsed)).toBe(0)
 expect(signedSpill(crest,crest+.1,1000,500,parsed)).toBeCloseTo(-forward/2,10)
 expect(()=>signedSpill(NaN,0,1000,500,parsed)).toThrow()
 expect(()=>signedSpill(5,0,0,500,parsed)).toThrow()
})
test('open-pool input owns one finite prepared geometry',()=>{
 expect(()=>parseOpenPools(doc({...b,unowned:true}))).toThrow()
 expect(()=>parseOpenPools(doc({...b,initialReceiverVolume_m3:20}))).toThrow()
 expect(()=>parseOpenPools(doc({...b,collectionFloor_m:5}))).toThrow()
 expect(()=>parseOpenPools(doc({...b,tankArea_m2:0}))).toThrow()
 expect(()=>parseOpenPools(doc(b)+doc(b))).toThrow()
})
