import {expect,test} from 'bun:test'
import {assembleReceivingWater} from './reference-design-source-receiving-water'
const liquid={pressure_Pa:101325,temperature_K:298.15,density_kg_m3:997,u_J_kg:1e5,h_J_kg:100101.63},
 chemistry={markerRatio:.002,atomsPerMarker:1e25,avogadro:6.02214076e23},
 pieces=[{owner:'POOL',sourceRegionId:'POOL/a',volume_m3:2,momentZ_m4:8},{owner:'POOL',sourceRegionId:'POOL/b',volume_m3:3,momentZ_m4:18}]
test('receiving mass and exact first moment use own uniform CNV density, not primary H/S state',()=>{
 const r=assembleReceivingWater(pieces,liquid,chemistry),s=r.nativeOwners[0]!.represented
 expect(s.water_kg).toBe(4985);expect(s.U_J).toBe(4985e5)
 expect(s.PE_J).toBeCloseTo(997*9.80665*26,8)
 expect(s.mobileN10/(4985*.002*1e25)).toBeCloseTo(1,14)
 expect(s.Htarget/(2*4985*chemistry.avogadro/.01801528)).toBeCloseTo(1,14)
 expect(s.HcaptureProduct).toBe(0);expect(s.BcaptureProduct).toBe(0)
 expect(r.completeReactorOperator).toBe(false)
 const split=assembleReceivingWater([{...pieces[0]!,volume_m3:1,momentZ_m4:3},{...pieces[0]!,sourceRegionId:'POOL/c',volume_m3:1,momentZ_m4:5},pieces[1]!],liquid,chemistry)
 const ss=split.nativeOwners[0]!.represented
 for(const k of Object.keys(s) as (keyof typeof s)[])expect(Math.abs(ss[k]-s[k])/Math.max(Math.abs(s[k]),1)).toBeLessThan(1e-14)
})
test('separate native owners and malformed/missing/duplicate stock support cannot silently mix',()=>{
 const r=assembleReceivingWater([pieces[0]!,{...pieces[1]!,owner:'WELL'}],liquid,chemistry)
 expect(r.nativeOwners.length).toBe(2)
 expect(()=>assembleReceivingWater([],liquid,chemistry)).toThrow('Missing')
 expect(()=>assembleReceivingWater([pieces[0]!,pieces[0]!],liquid,chemistry)).toThrow('Duplicated')
 expect(()=>assembleReceivingWater([{...pieces[0]!,volume_m3:-1}],liquid,chemistry)).toThrow('Invalid')
 expect(()=>assembleReceivingWater(pieces,{...liquid,density_kg_m3:0},chemistry)).toThrow()
 expect(()=>assembleReceivingWater(pieces,liquid,{...chemistry,markerRatio:-1})).toThrow()
 expect(()=>assembleReceivingWater([{...pieces[0]!,momentZ_m4:NaN}],liquid,chemistry)).toThrow()
})
