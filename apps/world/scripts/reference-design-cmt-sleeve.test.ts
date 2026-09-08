import { expect, test } from 'bun:test'
import { parseSleeveBasis } from './reference-design-cmt-sleeve'

const apertures = { holeDiameter_m: .06153846153846154, ringElevations_m: [11.925, 11.85, 11.775],
  holesPerRing: 10, coefficient: .62, pressure_MPa: 15.2, duration_s: 1, steps_s: [.01, .005],
  massResidual_kg: 1e-6, energyResidual_J: .1, entropyTolerance_J_K: .01,
  temperatureDifference_K: .1, pressureDifference_Pa: 1000, relativeGrossFlowDifference: .01 }
const sleeve = { innerDiameter_m: .6, wall_m: .003, bottom_m: 11.45, top_m: 11.98,
  supportWidth_m: .01, supportHeight_m: .01, supportBottom_m: 11.96, darcyFactor: .02,
  roofTurnCoefficient: 1, entryCoefficient: 1, exitCoefficient: 1, availableHead_Pa: 2000 }
const document = (s = sleeve) => '```reference-cmt-apertures\n' + JSON.stringify(apertures) +
  '\n```\n```reference-cmt-sleeve\n' + JSON.stringify(s) + '\n```\n'

test('sleeve fixture preserves actual radial geometry and available head', () => {
  const b = parseSleeveBasis(document())
  expect(b.holeDiameter_m).toBe(apertures.holeDiameter_m)
  expect(b.sleeve.availableHead_Pa).toBe(2000)
  expect(b.sleeve.top_m).toBe(11.98)
})

test('sleeve cannot occupy roof, body, aperture or unexplained input', () => {
  expect(() => parseSleeveBasis(document({ ...sleeve, top_m: 12 }))).toThrow()
  expect(() => parseSleeveBasis(document({ ...sleeve, innerDiameter_m: .4 }))).toThrow()
  expect(() => parseSleeveBasis(document({ ...sleeve, supportBottom_m: 11.94 }))).toThrow()
  expect(() => parseSleeveBasis(document().replace('"wall_m":0.003', '"wall_m":0.003,"mixingRate":1'))).toThrow()
  expect(() => parseSleeveBasis(document() + document())).toThrow()
})
