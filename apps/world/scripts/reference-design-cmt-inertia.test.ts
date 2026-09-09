import { expect, test } from 'bun:test'
import { inertiaSchema, parseInertiaBasis } from './reference-design-cmt-inertia'

// Numerical ownership fixture only, not a thermodynamic trajectory.
const limits = { maximumDensityFraction: .05, maximumNumericalHeatFraction: .1,
  zeroDissipationEnergy_J: 1e-9, modalResidual_kg_s: 1e-7 } as const

test('finite inertia screens are explicit frozen limits, not fitted coefficients', () => {
  expect(inertiaSchema.parse(limits)).toEqual(limits)
  expect(() => inertiaSchema.parse({ ...limits, maximumDensityFraction: .5 })).toThrow()
  expect(() => inertiaSchema.parse({ ...limits, relaxationTime_s: 1 })).toThrow()
})

test('inertia parser rejects missing or duplicate owned input', () => {
  expect(() => parseInertiaBasis('')).toThrow()
  const block = '```reference-cmt-inertia\n' + JSON.stringify(limits) + '\n```\n'
  expect(() => parseInertiaBasis(block + block)).toThrow()
})
