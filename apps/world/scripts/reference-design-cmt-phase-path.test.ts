import { expect, test } from 'bun:test'
import { allocateOpenCheck, parsePhasePathBasis } from './reference-design-cmt-phase-path.ts'

const basis = { openCheckLoss_Pa: 250, pressure_Pa: 5e6, steamSuperheat_K: 20, mixedQuality: .2, boronLiquidFraction: .002, cmtRawDPSpan_Pa: 8000 } as const
const block = (value: unknown) => '```reference-cmt-phase-path\n' + JSON.stringify(value) + '\n```'

test('phase-path input is explicit and standalone, without sibling wiki reads', () => {
  expect(parsePhasePathBasis(block(basis))).toEqual(basis)
  expect(() => parsePhasePathBasis('')).toThrow()
  expect(() => parsePhasePathBasis(block(basis) + '\n' + block(basis))).toThrow()
  expect(() => parsePhasePathBasis(block({ ...basis, mixedQuality: 10000 }))).toThrow()
  expect(() => parsePhasePathBasis(block({ ...basis, arbitraryLeakFloor: 1e-6 }))).toThrow()
})

test('physical check allocation consumes the existing allowance exactly once', () => {
  const a = allocateOpenCheck(17469.38711589653, 250)
  expect(a.openCheck_Pa).toBe(250)
  expect(a.isolation_Pa).toBeCloseTo(17219.38711589653, 10)
  expect(a.openCheck_Pa + a.isolation_Pa).toBe(a.combined_Pa)
})

test('a missing or excessive check loss is not a numerical regularization', () => {
  for (const [remaining, check] of [[250, 250], [249, 250], [1000, 0], [1000, -1], [Infinity, 250], [1000, NaN]])
    expect(() => allocateOpenCheck(remaining!, check!)).toThrow()
})
