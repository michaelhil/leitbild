import { expect, test } from 'bun:test'
import { parsePatchBasis } from './reference-design-cmt-patches'

// Self-contained parser fixture, not a physical run or external wiki dependency.
const owner = '```reference-cmt-apertures\n' + JSON.stringify({
  holeDiameter_m: .06153846153846154, ringElevations_m: [11.925, 11.85, 11.775], holesPerRing: 10,
  coefficient: .62, pressure_MPa: 15.2, duration_s: 1, steps_s: [.01, .005], massResidual_kg: 1e-6,
  energyResidual_J: .1, entropyTolerance_J_K: .01, temperatureDifference_K: .1,
  pressureDifference_Pa: 1000, relativeGrossFlowDifference: .01,
}) + '\n```\n```reference-cmt-patches\n' + JSON.stringify({
  bodyRadius_m: .205, pitch_m: .075, extentDiameters: [1, 2], returnLoss: 1,
  initialPlenum_C: 290, initialResident_C: 40, firstDuration_s: .1, challengeDuration_s: 1,
  steps_s: [.002, .001], coolingStart_s: .05, coolingConductance_W_K: 1e6,
  calorimeterCapacity_J_K: 1e6, calorimeterInitial_C: 20, localMassTolerance_kg: 1e-7,
  localEnergyTolerance_J: .01, totalMassTolerance_kg: 1e-5, totalEnergyTolerance_J: 1,
  entropyTolerance_J_K: .01, temporalTemperature_K: .2, temporalPressure_Pa: 5000, temporalGrossFraction: .02,
}) + '\n```\n'

test('finite patch fixture owns geometry and event-aligned two-batch limits', () => {
  const b = parsePatchBasis(owner)
  expect(b.patches.extentDiameters).toEqual([1, 2])
  expect(b.patches.steps_s).toEqual([.002, .001])
  expect(b.patches.bodyRadius_m).toBe(.205)
})

test('rejects unowned geometry, nonaligned clocks and duplicate fixture blocks', () => {
  expect(() => parsePatchBasis(owner.replace('"bodyRadius_m":0.205', '"bodyRadius_m":0.3'))).toThrow()
  expect(() => parsePatchBasis(owner.replace('"challengeDuration_s":1', '"challengeDuration_s":1.0003'))).toThrow()
  expect(() => parsePatchBasis(owner + '\n```reference-cmt-patches\n{}\n```\n')).toThrow()
})
