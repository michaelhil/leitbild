import { expect,test } from 'bun:test'
import { parseBulkCondensation } from './reference-design-bulk-condensation.ts'
const basis:ReturnType<typeof parseBulkCondensation>={design:'LD-01-bulk-condensation',pressure_MPa:5,initialVolume_m3:.001,initialVoidFraction:.05,
  initialBubbleDiameter_m:.003,minimumDiameter_m:.0001,relativeVelocity_m_s:.2,hydraulicDiameter_m:.012,
  duration_s:2,steps_s:[.002,.001,.0005]}
const doc=(x:unknown)=>'```reference-bulk-condensation\n'+JSON.stringify(x)+'\n```\n'
test('finite bath requires explicit bounded geometry and refinement',()=>{
  expect(parseBulkCondensation(doc(basis))).toEqual(basis)
  expect(()=>parseBulkCondensation('')).toThrow()
  expect(()=>parseBulkCondensation(doc(basis)+doc(basis))).toThrow()
  for(const change of [{pressure_MPa:15},{initialVoidFraction:.5},{minimumDiameter_m:.004},
    {initialBubbleDiameter_m:.02},{steps_s:[.002,.001,.0004]},{duration_s:0},{unknown:true}])
    expect(()=>parseBulkCondensation(doc({...basis,...change}))).toThrow()
})
