import { describe,expect,test } from 'bun:test'
import { parseProfileBasis } from './reference-design-cmt-profile'
const basis:ReturnType<typeof parseProfileBasis>={height_m:1.95,cold_C:20,hot_C:200,pressures_MPa:[2,3.15,4.3],readingTemperature_K:10,readingHeight_m:.02,points:[[55,1.30],[146,1.38],[161,1.397],[194,1.55],[200,1.63]]}
const page=(x:unknown)=>'```reference-cmt-profile\n'+JSON.stringify(x)+'\n```\n'
describe('CMT source-profile reference boundary',()=>{
  test('retains exact declared reading bands and material-coordinate scalar',()=>{
    expect(parseProfileBasis(page(basis))).toEqual(basis)
  })
  test('rejects unknown inputs, impossible points, and ambiguous blocks',()=>{
    expect(()=>parseProfileBasis(page({...basis,mixingCoefficient:1}))).toThrow()
    expect(()=>parseProfileBasis(page({...basis,points:[[55,-1],[146,1.38],[161,1.397]]}))).toThrow()
    expect(()=>parseProfileBasis(page(basis)+page(basis))).toThrow()
    expect(()=>parseProfileBasis(page({...basis,cold_C:210}))).toThrow()
  })
})
