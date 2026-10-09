import { expect, test } from 'bun:test'
import { exponentialConvolution, parseOperatingEnergy } from './reference-design-operating-energy'

test('finite exponential preparation convolution handles equal, tiny and long ages', () => {
  expect(exponentialConvolution(0, 0, 17)).toBe(17)
  expect(exponentialConvolution(.3, .3, 4)).toBeCloseTo(4 * Math.exp(-1.2), 14)
  expect(exponentialConvolution(.1, .4, 7)).toBeCloseTo((Math.exp(-.7) - Math.exp(-2.8)) / .3, 14)
  expect(exponentialConvolution(.4, .1, 7)).toBe(exponentialConvolution(.1, .4, 7))
  expect(exponentialConvolution(1e-15, 2e-15, 1e-3)).toBeCloseTo(1e-3, 17)
  expect(exponentialConvolution(.001, .002, 1e9)).toBe(0)
  expect(() => exponentialConvolution(-1, 2, 3)).toThrow()
  expect(() => exponentialConvolution(1, NaN, 3)).toThrow()
})

test('one explicit energy record rejects duplicates, extras and missing selections', () => {
  const record = { identity: 'LD01-HOT-ENERGY-1', preparationDuration_s: 2592000,
    fertileCapture_barn: 4, fertileBinding_MeV: 4.8, xenonBinding_MeV: 8.1, samariumBinding_MeV: 8,
    bindingCoolantFraction: .1, bindingCoolantSensitivity: [0, .1, .2],
    promptFissionCoolantFraction: .02, promptFissionCoolantSensitivity: [0, .02, .05] }
  const doc = (value: object) => '```reference-operating-energy\n' + JSON.stringify(value) + '\n```\n'
  expect(parseOperatingEnergy(doc(record)).bindingCoolantFraction).toBe(.1)
  expect(() => parseOperatingEnergy(doc(record) + doc(record))).toThrow()
  expect(() => parseOperatingEnergy(doc({ ...record, legacyCaptureRatio: .8 }))).toThrow()
  expect(() => parseOperatingEnergy(doc({ ...record, fertileCapture_barn: 0 }))).toThrow()
  const { preparationDuration_s: _omitted, ...incomplete } = record
  expect(() => parseOperatingEnergy(doc(incomplete))).toThrow()
})
