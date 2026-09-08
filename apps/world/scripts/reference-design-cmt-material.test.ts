import { expect,test } from 'bun:test'
import { parseMaterialBasis } from './reference-design-cmt-material.ts'

const base={design:'LD-01',duration_s:60,output_s:.25,initialPressure_MPa:15.2,primaryVolume_m3:220,
  hot_C:290,cold_C:40,layers:4,interlayerConductance_W_K:1000,relativeTolerance:1e-9,maximumStep_s:.25}
const limits={maximumStep_s:.25,pressureDifference_Pa:10000,interfaceDifference_m:.01,massResidual_kg:.0001,energyResidual_J:100}
const doc=(x:unknown)=>'```reference-cmt-fixture\n'+JSON.stringify(base)+'\n```\n'+
  '```reference-cmt-stratification\n{"topCells":12,"maximumStep_s":0.25}\n```\n'+
  '```reference-cmt-material\n'+JSON.stringify(x)+'\n```'
test('material reference adds explicit gates without rewriting historical thermal input',()=>{
  const parsed=parseMaterialBasis(doc(limits))
  expect(parsed.material).toEqual(limits)
  expect(parsed.interlayerConductance_W_K).toBe(1000)
})
test('material reference rejects missing, duplicate, nonfinite and unexplained mixing inputs',()=>{
  expect(()=>parseMaterialBasis('')).toThrow()
  expect(()=>parseMaterialBasis(doc(limits)+'\n```reference-cmt-material\n{}\n```')).toThrow()
  for(const x of [{...limits,entrainment:.1},{...limits,maximumStep_s:1},{...limits,pressureDifference_Pa:0},
    {...limits,energyResidual_J:Infinity}])expect(()=>parseMaterialBasis(doc(x))).toThrow()
})
