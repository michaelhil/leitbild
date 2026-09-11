import { describe, expect, test } from 'bun:test'
import { allocateMixingBudget, parseOperatingPointSelection } from './reference-design-primary-operating-point'
import { parseConnectedFuelSelection } from './reference-design-connected-fuel'

describe('bounded primary operating-point inputs',()=>{
  test('actual discharge mixing consumes the total loss budget once',()=>{
    expect(allocateMixingBudget(1.2,1)).toBeCloseTo(.2,14)
    expect(allocateMixingBudget(1,1)).toBe(0)
    for(const bad of [.5,-1,Infinity,NaN])expect(()=>allocateMixingBudget(bad,1)).toThrow()
  })
  test('takeoff is a declared finite location, not an implicit cell average',()=>{
    const doc='```reference-primary-operating-point\n{"surgeTakeoffFraction":0.5,"lowerReferencePressure_MPaAbs":15.2}\n```'
    expect(parseOperatingPointSelection(doc).surgeTakeoffFraction).toBe(.5)
    expect(()=>parseOperatingPointSelection(doc+doc)).toThrow()
    expect(()=>parseOperatingPointSelection(doc.replace('0.5','1.1'))).toThrow()
  })
  test('existing grid selection exposes exact authored positions without a second schema',()=>{
    const selection={gridPositions_m:[.25,.75,1.25,1.75,2.25,2.75,3.25,3.75],blockageFraction:.35,gridLossFactor:1,inletLoss:.5,outletLoss:1}
    expect(parseConnectedFuelSelection('```reference-connected-fuel\n'+JSON.stringify(selection)+'\n```')).toEqual(selection)
  })
})
