import { expect, test } from 'bun:test'
import { parseObservationFixtureBasis, observationCalculation, flowEvidence } from './reference-design-observations.ts'

const basis: ReturnType<typeof parseObservationFixtureBasis> = {
  design:'LD-01',gravity_m_s2:9.80665,rawDPZeroBound_Pa:5,rawDPQuantum_Pa:.5,
  flowLag_s:.25,sample_s:.1,
  meters:[
    {name:'CMT',referenceFlow_kg_s:25,meterDrop_Pa:2000,totalReferenceDrop_Pa:20000},
    {name:'ACC',referenceFlow_kg_s:100,meterDrop_Pa:100000,totalReferenceDrop_Pa:1000000},
    {name:'GIV',referenceFlow_kg_s:60,meterDrop_Pa:5000,totalReferenceDrop_Pa:50000},
    {name:'RECIRC',referenceFlow_kg_s:60,meterDrop_Pa:2000,totalReferenceDrop_Pa:20000},
    {name:'DVI',referenceFlow_kg_s:100,meterDrop_Pa:1000,totalReferenceDrop_Pa:10000},
    {name:'PRHR',referenceFlow_kg_s:350,meterDrop_Pa:2000,totalReferenceDrop_Pa:20000},
    {name:'RHR',referenceFlow_kg_s:150,meterDrop_Pa:20000,totalReferenceDrop_Pa:200000},
  ],
  liquidDensity_kg_m3:700,gasDensity_kg_m3:30,voidFractions:[0,.5,.9,.99,1],
  levelPressure_MPaAbs:14.914398370832105,levelHeight_m:12,levelLiquidHeight_m:6,
  referenceCold_C:40,referenceHot_C:150,referenceVoidFraction:.5,levelLag_s:.5,levelRawError_Pa:50,
  cmtHeight_m:6,cmtPressure_MPaAbs:15.2,cmtCold_C:40,cmtHot_C:290,
  subcoolingTotalPressure_MPaAbs:1,subcoolingFluid_C:126.85,
  probeCapacity_J_K:10,probeLiquidUA_W_K:10,probeGasUA_W_K:.2,
  probeInitial_C:100,probeHotFluid_C:300,probeObservation_s:10,
}
const doc=(v:unknown)=>'# Observation\n\n```reference-observation-fixtures\n'+JSON.stringify(v)+'\n```\n'

test('accepts one strictly numerical observation basis, never executable wiki source',()=>{
  expect(parseObservationFixtureBasis(doc(basis))).toEqual(basis)
  for(const text of [doc(basis)+doc(basis),'```python\nprint(1)\n```','```reference-observation-fixtures\n{bad}\n```'])
    expect(()=>parseObservationFixtureBasis(text)).toThrow()
  expect(observationCalculation).not.toContain('eval(')
  expect(observationCalculation).not.toContain('exec(')
})

test('rejects missing, extra, non-finite and physically inconsistent input',()=>{
  for(const edit of [
    {design:'PWR'}, {sample_s:1}, {flowLag_s:0}, {rawDPZeroBound_Pa:-1},
    {probeCapacity_J_K:undefined}, {arbitraryCode:'print(1)'}, {gravity_m_s2:Infinity},
    {liquidDensity_kg_m3:20}, {levelLiquidHeight_m:13}, {referenceVoidFraction:1.01},
    {referenceHot_C:30}, {cmtHot_C:30}, {probeGasUA_W_K:20}, {probeHotFluid_C:20},
    {voidFractions:[0,-.1]}, {meters:basis.meters.slice(1)},
    {meters:basis.meters.map(m=>({...m,name:'CMT'}))},
    {meters:basis.meters.map(m=>({...m,meterDrop_Pa:m.totalReferenceDrop_Pa+1}))},
    {meters:basis.meters.map(m=>({...m,unknown:1}))},
  ])expect(()=>parseObservationFixtureBasis(doc({...basis,...edit}))).toThrow()
  expect(()=>parseObservationFixtureBasis(doc(basis).replace('700','1e999'))).toThrow()
})

test('delivered DP interval preserves ambiguous direction and cannot call zero established delivery',()=>{
  for(const dp of [-5.25,0,5.25]) {
    const e=flowEvidence(dp,100,1000,5.25)
    expect(e.direction).toBe('unresolved')
    expect(e.condition).toBe('indeterminate')
    expect(e.lowerLiquidCalibration_kg_s).toBeLessThanOrEqual(0)
    expect(e.upperLiquidCalibration_kg_s).toBeGreaterThanOrEqual(0)
  }
  expect(flowEvidence(0,25,2000,5.25).condition).toBe('low_established')
  expect(flowEvidence(0,350,2000,5.25).condition).toBe('indeterminate')
})

test('uses both interval ends for asymmetric forward, reverse and hysteresis evidence',()=>{
  const f=flowEvidence(6.5,100,1000,5.25)
  const r=flowEvidence(-6.5,100,1000,5.25)
  expect(f.lowerLiquidCalibration_kg_s).toBeCloseTo(Math.sqrt(12.5),10)
  expect(f.upperLiquidCalibration_kg_s).toBeCloseTo(Math.sqrt(117.5),10)
  expect(f.condition).toBe('positive_established')
  expect(r.condition).toBe('reverse_established')
  expect(r.lowerLiquidCalibration_kg_s).toBe(-f.upperLiquidCalibration_kg_s)
  expect(r.upperLiquidCalibration_kg_s).toBe(-f.lowerLiquidCalibration_kg_s)
  expect(flowEvidence(5.5,100,1000,5.25).direction).toBe('forward')
  expect(flowEvidence(5.5,100,1000,5.25).condition).toBe('indeterminate')
  expect(flowEvidence(.625,100,1000,0).condition).toBe('indeterminate') // exactly 2.5 kg/s
  for(const values of [[NaN,100,1000,5], [0,0,1000,5], [0,100,-1,5], [0,100,1000,-1]])
    expect(()=>flowEvidence(...values as [number,number,number,number])).toThrow()
})
