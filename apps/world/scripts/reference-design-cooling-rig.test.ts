import { describe, expect, test } from 'bun:test'
import { parseCoolingRigBasis } from './reference-design-cooling-rig'

const basis = {
  design:'LD-01 cooling-source bench',vesselVolume_m3:220,vesselHeight_m:10,initialPressure_MPa:1,
  initialLiquidFraction:.3,steamPort_m:9.5,injectionPort_m:3,ambientPressure_MPa:.101325,
  poolTemperature_C:25,heater_MW:3,duration_s:900,step_s:.25,ADS_CdA_m2:.006,
  WSTArea_m2:200,WSTFloor_m:8,WSTVolume_m3:1200,sumpArea_m2:200,sumpFloor_m:-2,sumpRim_m:4,
  floorArea_m2:800,sourceLoss_Pa:50000,recircLoss_Pa:20000,sourceReferenceFlow_kg_s:60,
  DVILoss_Pa:10000,DVIReferenceFlow_kg_s:100,checkCracking_Pa:1000,
  ACTCapacity_kJ:54720,ACTAvailable_kW:20,ACTBaseline_kW:2,releasePower_kW:2,releaseDuration_s:.5,travel_s:.5,
} as const
const doc = (x: unknown) => `# Bench\n\n\`\`\`reference-cooling-rig\n${JSON.stringify(x)}\n\`\`\`\n`
describe('cooling-source rig input',()=>{
  test('accepts one strict numeric basis',()=>expect(parseCoolingRigBasis(doc(basis))).toEqual(basis))
  test('rejects unknown fields',()=>expect(()=>parseCoolingRigBasis(doc({...basis,code:'print(1)'}))).toThrow())
  test('rejects duplicate or missing blocks',()=>{
    expect(()=>parseCoolingRigBasis(doc(basis)+doc(basis))).toThrow()
    expect(()=>parseCoolingRigBasis('# no basis')).toThrow()
  })
  test('rejects submerged steam port and unresolved actuation time',()=>{
    expect(()=>parseCoolingRigBasis(doc({...basis,steamPort_m:2}))).toThrow()
    expect(()=>parseCoolingRigBasis(doc({...basis,step_s:.5}))).toThrow()
  })
  test('rejects a pressure or geometry outside the declared bench',()=>{
    expect(()=>parseCoolingRigBasis(doc({...basis,initialPressure_MPa:.01}))).toThrow()
    expect(()=>parseCoolingRigBasis(doc({...basis,sumpRim_m:2}))).toThrow()
  })
})
