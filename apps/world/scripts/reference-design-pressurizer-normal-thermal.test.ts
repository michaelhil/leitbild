import { describe, expect, test } from 'bun:test'
import { parseNormalThermal } from './reference-design-pressurizer-normal-thermal'

describe('normal PZR thermal selection',()=>{
  const data={bypassConductanceFraction:.005,sprayReferenceFlow_kg_s:20,sprayReferenceDifferential_Pa:200000,
    sprayLength_m:25,sprayInsideDiameter_m:.1,sprayWallThickness_m:.01,vesselThermalWallThickness_m:.15,
    insulationThickness_m:.1,insulationConductivity_W_mK:.06,exteriorCoefficient_W_m2K:8,
    liquidContact_W_m2K:1000,vaporContact_W_m2K:2000,ambient_K:313.15,heaterCapacity_W:3000000,heaterProportionalBand_Pa:100000}
  const page=(x:unknown)=>'```reference-pressurizer-normal-thermal\n'+JSON.stringify(x)+'\n```'
  test('one explicit complete sizing record, not silent thermal defaults',()=>{
    expect(parseNormalThermal(page(data))).toEqual(data)
    expect(()=>parseNormalThermal(page({...data,insulationConductivity_W_mK:0}))).toThrow()
    expect(()=>parseNormalThermal(page({...data,bypassConductanceFraction:2}))).toThrow()
    expect(()=>parseNormalThermal(page({...data,hiddenHeater:1}))).toThrow()
    expect(()=>parseNormalThermal(page(data)+ '\n'+page(data))).toThrow()
  })
})
