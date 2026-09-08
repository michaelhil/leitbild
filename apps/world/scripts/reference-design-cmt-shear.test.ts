import { expect, test } from 'bun:test'
import { parseShearBasis } from './reference-design-cmt-shear'

const apertures = { holeDiameter_m: .06153846153846154, ringElevations_m: [11.925, 11.85, 11.775],
  holesPerRing: 10, coefficient: .62, pressure_MPa: 15.2, duration_s: 1, steps_s: [.01, .005],
  massResidual_kg: 1e-6, energyResidual_J: .1, entropyTolerance_J_K: .01,
  temperatureDifference_K: .1, pressureDifference_Pa: 1000, relativeGrossFlowDifference: .01 }
const shear = { velocityCoefficient: .98, lengthRatio: .07, turbulentPrandtl: .7,
  duration_s: 5, steps_s: [.002, .001], coolingStart_s: .5, coolingConductance_W_K: 500,
  calorimeterCapacity_J_K: 10000, calorimeterInitial_C: 20, energyTolerance_J: 1e-6,
  momentumTolerance_kg_m_s: 1e-10, entropyTolerance_J_K: 1e-6,
  temperatureTolerance_K: .01, velocityTolerance_m_s: 1e-4 }
const document = (s = shear) => '```reference-cmt-apertures\n' + JSON.stringify(apertures) +
  '\n```\n```reference-cmt-shear\n' + JSON.stringify(s) + '\n```\n'

test('constitutive boundary retains selected coefficient and exact finite clocks', () => {
  const b = parseShearBasis(document())
  expect(b.shear.velocityCoefficient).toBe(.98)
  expect(b.shear.steps_s).toEqual([.002, .001])
  expect(b.coefficient).toBe(.62)
})

test('invalid area contraction, clock and unowned mixing law are rejected', () => {
  expect(() => parseShearBasis(document({ ...shear, velocityCoefficient: .6 }))).toThrow()
  expect(() => parseShearBasis(document({ ...shear, coolingStart_s: .5001 }))).toThrow()
  expect(() => parseShearBasis(document().replace('"lengthRatio":0.07', '"lengthRatio":0.07,"entrainment":0.1'))).toThrow()
  expect(() => parseShearBasis(document() + document())).toThrow()
})
