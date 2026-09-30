import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { parseColdParent, coldSourceIsolationAssessment, freshColdInputAssessment, coldParentCalculation } from './reference-design-cold-parent'
import { coldPzrPreparationPython, coldPressureCalculation } from './reference-design-cold-pressure'

const selected={primaryAbsorberRatio:.001,passiveAbsorberRatio:.002,warm_K:313.15,ccw_K:303.15,site_K:293.15,passive_K:298.15,room_K:298.15,qualificationInput_s:5,comparisonPower_W:100000}
const document=(input:unknown)=>'```reference-cold-parent\n'+JSON.stringify(input)+'\n```\n'
describe('bounded cold-parent input and source boundary',()=>{
  test('strict finite preparation input, not an additional mode language',()=>{
    expect(parseColdParent(document(selected))).toEqual(selected)
    expect(()=>parseColdParent(document({...selected,site_K:0}))).toThrow()
    expect(()=>parseColdParent(document({...selected,imposedPower_W:0}))).toThrow()
    expect(()=>parseColdParent(document(selected)+document(selected))).toThrow()
  })
  test('existing charged ACC isolation is not supplied by its checks',()=>{
    expect(coldSourceIsolationAssessment(false,false)).toEqual({coldAccumulatorIsolated:true,pressureBalancedCmtCredited:false,chargedSourceColdPreparationAccepted:true})
    expect(coldSourceIsolationAssessment(true,false).chargedSourceColdPreparationAccepted).toBe(false)
    expect(coldSourceIsolationAssessment(false,true).pressureBalancedCmtCredited).toBe(true)
  })
  test('t0 accepted COLD is independent of denied withdrawal/reset histories',()=>{
    const low=freshColdInputAssessment('LOW_BOUND')
    expect(low.healthyLowBoundSupportsInitialColdAlignment).toBe(true)
    expect(low.qualificationTimer_s).toBe(0)
    expect(low.ordinaryWithdrawalQualified).toBe(false)
    expect(low.operationalPowerToColdQualified).toBe(false)
    for(const input of ['UNAVAILABLE','UNKNOWN'] as const){const result=freshColdInputAssessment(input);expect(result.healthyLowBoundSupportsInitialColdAlignment).toBe(false);expect(result.ordinaryWithdrawalQualified).toBe(false);expect(result.acceptedColdSettingRetained).toBe(true)}
  })
  test('named PZR extraction leaves entire original physical payload identical',()=>{
    expect(createHash('sha256').update(coldPressureCalculation).digest('hex')).toBe('9d41ad05b5739008d558156a1fbd43d838a577daefb4477260f827ebbc9d7b62')
    expect(coldParentCalculation.includes(coldPzrPreparationPython)).toBe(true)
    expect(coldParentCalculation.match(/Original cold centroid projection/g)?.length).toBe(1)
  })
})
