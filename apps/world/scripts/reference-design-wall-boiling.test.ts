import { expect,test } from 'bun:test'
import { parseWallBoilingStudy } from './reference-design-wall-boiling.ts'
const input={design:'LD-01-wall-boiling-comparison' as const,hydraulicDiameter_m:.012,area_m2:1,
  contactAngle_deg:38,surfaceFactor:1,vaporVolumeFraction:.05,pressures_MPa:[1,5,10,15,16],
  liquidMassFlux_kg_m2s:3933,subcooling_K:[0,5,20,50],superheats_K:[0,2,5,10],
  dutyHeatFluxes_W_m2:[0,20000,500000,1000000],dutySuperheatCeiling_K:10}
const doc=(x:unknown)=>'```reference-wall-boiling\n'+JSON.stringify(x)+'\n```\n'
test('wall-boiling comparison requires one strict explicit basis',()=>{
  expect(parseWallBoilingStudy(doc(input))).toEqual(input)
  expect(()=>parseWallBoilingStudy('')).toThrow()
  expect(()=>parseWallBoilingStudy(doc(input)+doc(input))).toThrow()
  for(const change of [{surfaceFactor:0},{pressures_MPa:[22]},{liquidMassFlux_kg_m2s:0},
    {subcooling_K:[-1]},{superheats_K:[Infinity]},{hydraulicDiameter_m:undefined},
    {contactAngle_deg:190},{liveAdmission:true},{pressures_MPa:[]},{vaporVolumeFraction:.99},
    {dutyHeatFluxes_W_m2:[-1]},{dutyHeatFluxes_W_m2:[]},{dutySuperheatCeiling_K:0}])
    expect(()=>parseWallBoilingStudy(doc({...input,...change}))).toThrow()
})
