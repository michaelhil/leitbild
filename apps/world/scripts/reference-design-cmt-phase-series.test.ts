import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { phasePathCalculation } from './reference-design-cmt-phase-path.ts'
import { phaseSeriesParent } from './reference-design-cmt-phase-series.ts'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
// Test-only receipt for the identity gate; no thermodynamic result is claimed.
const input = { bore_m: .2, fixture: 'standalone parent identity' }
const fixture = { sourceHash: 'test-only', calculationHash: hash(phasePathCalculation), inputHash: hash(JSON.stringify(input)), input,
  calibrations: ['isolation', 'check', 'CMT-meter'].map(name => ({ name, effectiveArea_m2: .001, result: { admitted: true as const } })) }

test('serial reference accepts its explicit parent and exact unchanged calculation', () => {
  expect(phaseSeriesParent(fixture).input).toEqual(input)
  expect(hash(phasePathCalculation)).toBe('ef80a493495e08a0e9a30a3c33eac2392d6ed9ec861c93aee6b6a37437f1c21e')
})
test('changed input or calculation is not silently treated as the retained calibration', () => {
  expect(() => phaseSeriesParent({ ...fixture, input: { ...input, bore_m: .3 } })).toThrow()
  expect(() => phaseSeriesParent({ ...fixture, calculationHash: 'wrong' })).toThrow()
})
test('required device identity and actual finite-bore restriction are enforced', () => {
  expect(() => phaseSeriesParent({ ...fixture, calibrations: fixture.calibrations.slice(1) })).toThrow()
  expect(() => phaseSeriesParent({ ...fixture, calibrations: [...fixture.calibrations, fixture.calibrations[0]] })).toThrow()
  expect(() => phaseSeriesParent({ ...fixture, calibrations: fixture.calibrations.map(c => ({ ...c, effectiveArea_m2: .1 })) })).toThrow()
  expect(() => phaseSeriesParent({ ...fixture, calibrations: fixture.calibrations.map(c => ({ ...c, result: { admitted: false } })) })).toThrow()
})
