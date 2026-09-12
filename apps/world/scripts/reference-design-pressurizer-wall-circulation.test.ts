import {expect,test} from 'bun:test'
import {parseHeadCollection} from './reference-design-pressurizer-head-collection'
const input={capillaryRadiusFactor:1,inertialDragCoefficient:1}
const doc=(value:unknown)=>'```reference-pressurizer-head-collection\n'+JSON.stringify(value)+'\n```\n'
test('one explicit ceiling collection selection without hidden duty or time forcing',()=>{
  expect(parseHeadCollection(doc(input))).toEqual(input)
  expect(()=>parseHeadCollection('')).toThrow()
  expect(()=>parseHeadCollection(doc(input)+doc(input))).toThrow()
  for(const change of [{capillaryRadiusFactor:0},{capillaryRadiusFactor:-1},{inertialDragCoefficient:0},
    {inertialDragCoefficient:Infinity},{requiredGamma_kg_s:.001},{flightTime_s:1},{liveAdmission:true}])
    expect(()=>parseHeadCollection(doc({...input,...change}))).toThrow()
})
