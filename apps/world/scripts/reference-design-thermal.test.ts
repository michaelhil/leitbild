import { expect,test } from 'bun:test'
import { parseThermalStudy } from './reference-design-thermal.ts'
const basis={design:'LD-01-thermal-separate-effects' as const,pressure_MPaAbs:.101325,
  length_m:.25,outsideDiameter_m:.015,wallThickness_m:.001,pitch_m:.0195,
  solidDensity_kg_m3:8100,solidCp_J_kgK:502.08,solidConductivity_W_mK:23.244444444444444,
  initialSolid_C:600,initialPoolDepth_m:.025,injection_kg_s:.0005,
  steamR_J_kgK:461.5,steamCp_J_kgK:2080,wallEmissivity:.7,contactAngle_deg:38,
  duration_s:100,axialCells:[40,80,160] as [number,number,number],radialCells:4 as const,
  steps_s:[.04,.02,.01] as [number,number,number]}
const doc=(v:unknown)=>'```reference-thermal-study\n'+JSON.stringify(v)+'\n```\n'
test('thermal study accepts one explicit geometry and refinement case',()=>{
  expect(parseThermalStudy(doc(basis))).toEqual(basis)
  expect(()=>parseThermalStudy('```python\nprint(1)\n```')).toThrow()
  expect(()=>parseThermalStudy(doc(basis)+doc(basis))).toThrow()
})
test('thermal study rejects impossible geometry and misleading refinement inputs',()=>{
  for(const change of [{pitch_m:.014},{wallThickness_m:.008},{initialPoolDepth_m:.25},
    {steamCp_J_kgK:400},{axialCells:[80,40,160]},{steps_s:[.01,.02,.04]},
    {wallEmissivity:1.1},{radialCells:1},{radialCells:8},{pressure_MPaAbs:.05},
    {pressure_MPaAbs:1},{outsideDiameter_m:0},{equation:'custom'},
    {solidDensity_kg_m3:undefined},{steps_s:[.04,.02,Number.NaN]},
    {duration_s:Infinity},{axialCells:[40,80,160.5]}])expect(()=>parseThermalStudy(doc({...basis,...change}))).toThrow()
})
