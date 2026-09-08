import { expect,test } from 'bun:test'
import { parseSurgeBasis } from './reference-design-surge.ts'
const input={hotVolume_m3:15,lineLength_m:10,lineDiameter_m:.2,initialLiquid_C:319.983951,
  referenceFlow_kg_s:20,referenceLoss_Pa:20000,duration_s:4,pulse_s:1,heat_W:3e6,steps_s:[.1,.05,.025],phaseCells:4,axialConductivityBound_W_mK:1}
const pzr='```reference-pressurizer\n'+JSON.stringify({design:'LD-01',volume_m3:60,liquidVolume_m3:30,area_m2:5,bottomElevation_m:2.5,
  hotPortPressure_MPa:14.95,minimumPressure_MPa:14,maximumPressure_MPa:16,heatIncrement_J:3e6})+'\n```'
const doc=(x:unknown)=>'```reference-surge\n'+JSON.stringify(x)+'\n```'
test('surge uses strict inputs and the existing PZR owner',()=>{
  expect(parseSurgeBasis(doc(input),pzr).pzr.volume_m3).toBe(60)
  for(const x of [{lineDiameter_m:0},{duration_s:.5},{steps_s:[.1,.07,.025]},{phaseCells:1},{pressureClamp:true}])
    expect(()=>parseSurgeBasis(doc({...input,...x}),pzr)).toThrow()
  expect(()=>parseSurgeBasis(doc(input)+doc(input),pzr)).toThrow()
})
