import { expect,test } from 'bun:test'
import { parseAmbientMaterials } from './reference-design-ambient-materials'
const fixture={ minimum_K:290,initialSolid_K:300,receiver_K:293.15,assessment_K:295,
 pressure_Pa:100000,length_m:.25,steel_kg:.05,steelArea_m2:.01,film_W_m2_K:250,
 water_kg:.2,insufficientWater_kg:.0002,duration_s:1000,step_s:5 } as const
const doc=(x:unknown)=>'```reference-ambient-materials\n'+JSON.stringify(x)+'\n```\n'
test('ambient fixture keeps source, finite receiver and assessment distinct',()=>{
 expect(parseAmbientMaterials(doc(fixture))).toEqual(fixture)
})
test('ambient admission cannot silently change floor, pressure or resource comparison',()=>{
 for(const bad of [{...fixture,minimum_K:280},{...fixture,receiver_K:300},{...fixture,pressure_Pa:15000000},
  {...fixture,water_kg:-1},{...fixture,insufficientWater_kg:.3},{...fixture,step_s:100},{...fixture,extra:1}])
  expect(()=>parseAmbientMaterials(doc(bad))).toThrow()
})
test('one owned observation block is required',()=>{
 expect(()=>parseAmbientMaterials('')).toThrow()
 expect(()=>parseAmbientMaterials(doc(fixture)+doc(fixture))).toThrow()
})
