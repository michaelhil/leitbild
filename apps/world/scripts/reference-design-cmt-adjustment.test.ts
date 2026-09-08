import {describe,expect,test} from 'bun:test'
import {apertureMembership,parseAdjustmentBasis} from './reference-design-cmt-adjustment.ts'
const input={area_m2:10,volume_m3:60,topElevation_m:12,initialTopPressure_MPa:15.13,
  volumeResidual_m3:1e-7,energyResidual_J:1,entropyTolerance_J_K:.01,
  quadraturePressureDifference_Pa:1,unmergedWorkResidual_J:1}
const document=(value:unknown)=>'```reference-cmt-adjustment\n'+JSON.stringify(value)+'\n```'
describe('finite CMT adjustment basis',()=>{
  test('strict finite numeric input',()=>{
    expect(parseAdjustmentBasis(document(input))).toEqual(input)
    expect(()=>parseAdjustmentBasis(document({...input,area_m2:0}))).toThrow()
    expect(()=>parseAdjustmentBasis(document({...input,hiddenMixingRate:1}))).toThrow()
    expect(()=>parseAdjustmentBasis(document(input)+document(input))).toThrow()
  })
  test('actual circular aperture extent, not a point or inferred flow fraction',()=>{
    const rows=[11.925,11.85,11.775],d=.2*Math.sqrt((30*4**2/13**2)/30)
    expect(apertureMembership(rows,d,12)).toEqual(['lower','lower','lower'])
    expect(apertureMembership(rows,d,11.9)).toEqual(['straddles','lower','lower'])
    expect(apertureMembership(rows,d,11.85)).toEqual(['upper','straddles','lower'])
    expect(apertureMembership(rows,d,11.7)).toEqual(['upper','upper','upper'])
    expect(()=>apertureMembership(rows,0,11.8)).toThrow()
  })
})
