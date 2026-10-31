import { describe, expect, test } from 'bun:test'
import { decodeProcessPlantSampleTimeRuns, encodeProcessPlantSampleTimeRuns, processPlantSampleTimeRunSchema } from '../src/packs/process-plant/procedure-evidence-facts.ts'

describe('lossless sampled-evidence timestamps', () => {
  test('retains ordered irregular, duplicate, negative and reversing times without rounding or discarding samples', () => {
    const cases = [[], [0], [10, 10], [0, 0, 0, 1000, 2000, 2000], [-2000, -1000, 0, 1000],
      [0, 1000, 2100, 3100, 4100, 5001], [0, 1000, 500, 500, 1500], [0, 0.1, 0.2, 0.3, 0.4],
      [Number.MAX_VALUE, -Number.MAX_VALUE, 0], Array.from({ length: 20_001 }, (_, index) => index * 997)]
    for (const offsets of cases) {
      const encoded = encodeProcessPlantSampleTimeRuns(offsets)
      expect(encoded.every(run => processPlantSampleTimeRunSchema.safeParse(run).success)).toBe(true)
      expect(encoded.reduce((count, run) => count + run.count, 0)).toBe(offsets.length)
      expect(decodeProcessPlantSampleTimeRuns(encoded)).toEqual(offsets)
    }
    expect(encodeProcessPlantSampleTimeRuns(cases.at(-1)!)).toEqual([{ firstOffsetMs: 0, stepMs: 997, count: 20_001 }])
  })

  test('arbitrary cadence changes remain lossless rather than projecting onto the configured recording interval', () => {
    let offset = -30_000
    const offsets = Array.from({ length: 8000 }, (_, index) => offset += [0, 7, 1000, 4, 4, 4000, -2][index % 7]!)
    expect(decodeProcessPlantSampleTimeRuns(encodeProcessPlantSampleTimeRuns(offsets))).toEqual(offsets)
    expect(encodeProcessPlantSampleTimeRuns([0, 1000, 2000, 5000, 8000, 11_000])).toEqual([
      { firstOffsetMs: 0, stepMs: 1000, count: 3 }, { firstOffsetMs: 5000, stepMs: 3000, count: 3 },
    ])
  })

  test('refuses nonfinite acquisition values and malformed run records explicitly', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(() => encodeProcessPlantSampleTimeRuns([0, value])).toThrow('finite')
    for (const run of [{ firstOffsetMs: 0, stepMs: 1, count: 0 }, { firstOffsetMs: 0, stepMs: 1, count: 1.5 },
      { firstOffsetMs: NaN, stepMs: 1, count: 2 }, { firstOffsetMs: 0, stepMs: Infinity, count: 2 },
      { firstOffsetMs: 0, stepMs: 1, count: 2, guessed: true }]) {
      expect(processPlantSampleTimeRunSchema.safeParse(run).success).toBe(false)
    }
  })
})
