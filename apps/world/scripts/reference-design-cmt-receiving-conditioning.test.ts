import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { receivingCalculation, parseReceivingBasis } from './reference-design-cmt-receiving'
import { diagnosticOrigin, retainedCalculationHash } from './reference-design-cmt-receiving-conditioning'

// Numeric parser fixture only; no fabricated physical state is used by a calculation.
const owner = '```reference-cmt-apertures\n' + JSON.stringify({
  holeDiameter_m: .06153846153846154, ringElevations_m: [11.925, 11.85, 11.775], holesPerRing: 10,
  coefficient: .62, pressure_MPa: 15.2, duration_s: 1, steps_s: [.01, .005], massResidual_kg: 1e-6,
  energyResidual_J: .1, entropyTolerance_J_K: .01, temperatureDifference_K: .1,
  pressureDifference_Pa: 1000, relativeGrossFlowDifference: .01,
}) + '\n```\n```reference-cmt-receiving\n' + JSON.stringify({
  duration_s: 10, contactAt_s: 5, calorimeterCapacity_J_K: 1e6, calorimeterConductance_W_K: 1e5,
  massResidual_kg: .0001, energyResidual_J: 1, volumeResidual_m3: 1e-7, entropyTolerance_J_K: .01,
  temporalTemperature_K: 1, temporalPressure_Pa: 10000, temporalGrossFraction: .05,
  spatialTemperature_K: 2, spatialPressure_Pa: 20000, spatialGrossFraction: .1,
}) + '\n```\n'
const artifact = () => ({ calculationHash: retainedCalculationHash,
  input: { ...parseReceivingBasis(owner), case: 'eight_fine' },
  cases: [{ name: 'eight_fine', status: 'REJECTED', attemptedTime_s: 9.8,
    lastAcceptedState: { t_s: 9.75 }, reason: 'Receipt local residual: parser fixture only' }],
})

test('diagnostic retains exact baseline and failed-step identity', () => {
  expect(createHash('sha256').update(receivingCalculation).digest('hex')).toBe(retainedCalculationHash)
  expect(diagnosticOrigin(artifact(), owner).diagnostic.state.t_s).toBe(9.75)
})

test('rejects source, input or case substitutions instead of silently replaying another step', () => {
  expect(() => diagnosticOrigin({ ...artifact(), calculationHash: 'different' }, owner)).toThrow()
  expect(() => diagnosticOrigin(artifact(), owner.replace('"pressure_MPa":15.2', '"pressure_MPa":15'))).toThrow()
  const different = artifact(); different.cases[0]!.attemptedTime_s = 9.9
  expect(() => diagnosticOrigin(different, owner)).toThrow()
  expect(() => diagnosticOrigin(null, owner)).toThrow()
})
