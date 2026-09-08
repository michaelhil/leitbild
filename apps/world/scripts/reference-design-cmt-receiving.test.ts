import { expect,test } from 'bun:test'
import { parseReceivingBasis } from './reference-design-cmt-receiving'

// Parser fixture only; the CLI reads the actual owning wiki for engineering runs.
const owner='```reference-cmt-apertures\n'+JSON.stringify({holeDiameter_m:.06153846153846154,
  ringElevations_m:[11.925,11.85,11.775],holesPerRing:10,coefficient:.62,pressure_MPa:15.2,
  duration_s:1,steps_s:[.01,.005],massResidual_kg:1e-6,energyResidual_J:.1,entropyTolerance_J_K:.01,
  temperatureDifference_K:.1,pressureDifference_Pa:1000,relativeGrossFlowDifference:.01})+'\n```\n'+
  '```reference-cmt-receiving\n'+JSON.stringify({duration_s:10,contactAt_s:5,calorimeterCapacity_J_K:1000000,
  calorimeterConductance_W_K:100000,massResidual_kg:.0001,energyResidual_J:1,volumeResidual_m3:1e-7,
  entropyTolerance_J_K:.01,temporalTemperature_K:1,temporalPressure_Pa:10000,temporalGrossFraction:.05,
  spatialTemperature_K:2,spatialPressure_Pa:20000,spatialGrossFraction:.1})+'\n```\n'
test('parser retains selected geometry and bounded receipt inputs',()=>{
  const b=parseReceivingBasis(owner)
  expect(b.ringElevations_m).toEqual([11.925,11.85,11.775])
  expect(b.receiving.duration_s).toBe(10)
  expect(b.receiving.calorimeterConductance_W_K).toBe(100000)
})
test('does not silently accept another experiment or duplicate input',()=>{
  expect(()=>parseReceivingBasis(owner.replace('"duration_s":10,"contactAt_s":5','"duration_s":20,"contactAt_s":5'))).toThrow()
  expect(()=>parseReceivingBasis(owner+owner)).toThrow()
})
