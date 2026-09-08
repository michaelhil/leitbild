import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { parseStratificationBasis, stratificationCalculation } from './reference-design-cmt-stratification.ts'

const base = { design: 'LD-01' as const, duration_s: 60, output_s: .25, initialPressure_MPa: 15.2,
  primaryVolume_m3: 220, hot_C: 290, cold_C: 40, layers: 4,
  interlayerConductance_W_K: 1000, relativeTolerance: 1e-9, maximumStep_s: .25 }
const doc = (value: unknown) => '```reference-cmt-fixture\n' + JSON.stringify(base) + '\n```\n' +
  '```reference-cmt-stratification\n' + JSON.stringify(value) + '\n```\n'

describe('CMT reconstruction study boundary', () => {
  test('records the accepted-state snapshot and actual tank-inlet output extension identity', () => {
    expect(createHash('sha256').update(stratificationCalculation).digest('hex')).toBe('ff7183d18bcab1932f9cd76f91ea186f5d47c00da79dc91c786f953b1f37683b')
  })
  test('retains the frozen physical input and accepts only numeric study settings', () => {
    expect(parseStratificationBasis(doc({ topCells: 12, maximumStep_s: .125 }))).toEqual({ ...base, topCells: 12, maximumStep_s: .125 })
    expect(() => parseStratificationBasis(doc({ topCells: 12, maximumStep_s: .25, mixing: 42 }))).toThrow()
  })
  test('rejects duplicate blocks and invalid mesh/timestep settings', () => {
    expect(() => parseStratificationBasis(doc({ topCells: 12, maximumStep_s: .25 }) + '\n```reference-cmt-stratification\n{}\n```')).toThrow()
    for (const value of [{ topCells: 0, maximumStep_s: .25 }, { topCells: 12, maximumStep_s: 0 }, { topCells: 12, maximumStep_s: 1 }])
      expect(() => parseStratificationBasis(doc(value))).toThrow()
  })
  test('rejects nonintegral or nonfinite top-cell settings', () => {
    expect(() => parseStratificationBasis(doc({ topCells: 12.5, maximumStep_s: .25 }))).toThrow()
    expect(() => parseStratificationBasis(doc({ topCells: Infinity, maximumStep_s: .25 }))).toThrow()
  })
})
