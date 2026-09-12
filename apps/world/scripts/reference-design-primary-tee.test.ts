import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { sharpCombiningCoefficients, sharpCombiningPolynomials, parsePrimaryTee, primaryTeePython } from './reference-design-primary-tee'
import { dividingIncrements, parseBidirectionalTee } from './reference-design-primary-tee-bidirectional'
import { regionalSupportCalculation } from './reference-design-pressurizer-regional-support'

describe('selected offline tee contract',()=>{
  test('retained regional extraction preserves every emitted calculation byte',()=>{
    expect(createHash('sha256').update(regionalSupportCalculation).digest('hex')).toBe('5145691cd260cbfe21edf2e6820bc56dafae606321bdf782de6d85662349cc64')
  })
  test('liquid helper extraction preserves the retained combining calculation',()=>{
    expect(createHash('sha256').update(primaryTeePython).digest('hex')).toBe('cef381223fae5933e8ab08b30c92f4cf00826b924b0b0911c219ec3a0e743dbe')
  })
  test('dividing increments reproduce independently expanded source equations',()=>{
    const a=100/9,f=.01,q=1-f,x=dividingIncrements(a,f)
    expect(x.through).toBeCloseTo(q*q-1.5*q+.5,14)
    expect(x.branch).toBeCloseTo((a*f)**2-2*a*f*Math.sqrt(2-Math.sqrt(2))/2,14)
    expect(dividingIncrements(a,0)).toEqual({through:0,branch:0})
    expect(()=>dividingIncrements(a,-.01)).toThrow()
    expect(parseBidirectionalTee('```reference-primary-bidirectional-tee\n{"model":"matched-oka1996-bassett2001","branchAngle_deg":90}\n```').branchAngle_deg).toBe(90)
  })
  test('independent published sharp equal-area and actual area endpoints',()=>{
    const equal=sharpCombiningCoefficients(1,1)
    expect(equal.through).toBeCloseTo(.524,10)
    expect(equal.branch).toBeCloseTo(1.09,10)
    const actual=sharpCombiningCoefficients((1/.3)**2,0)
    expect(actual.through).toBeCloseTo(.00405,12)
    expect(actual.branch).toBeCloseTo(-.9928,12)
    expect(sharpCombiningPolynomials(18).through.every(Number.isFinite)).toBe(true)
  })
  test('does not pretend combining coefficients implement dividing or arbitrary geometry',()=>{
    for(const f of [-.01,1.01,NaN])expect(()=>sharpCombiningCoefficients(11,f)).toThrow()
    for(const m of [.5,19,Infinity])expect(()=>sharpCombiningPolynomials(m)).toThrow()
    const block=(angle:number)=>'```reference-primary-tee\n'+JSON.stringify({model:'oka1996-sharp-combining',branchAngle_deg:angle,joiningEdgeRadiusRatio:0})+'\n```'
    expect(parsePrimaryTee(block(90)).branchAngle_deg).toBe(90)
    expect(()=>parsePrimaryTee(block(45))).toThrow()
  })
})
