import { describe, expect, test } from 'bun:test'
import { calculateSampleChanges, sampleChangesInputSchema } from './sample-changes.ts'

const timestamps = ['2026-07-12T04:01:10.043Z', '2026-07-12T04:01:15.043Z', '2026-07-12T04:01:20.043Z'] as const
const receiverA = [56979.28096543747, 57009.18854052584, 57074.0216446851]
const receiverB = [56933.65960980982, 56953.55986151602, 57007.69255427249]
const sampleInput = () => ({ timestamps: [...timestamps], series: [{ key: 'sgA', unit: 'kg', values: [...receiverA] }, { key: 'sgB', unit: 'kg', values: [...receiverB] }] })

describe('caller-supplied dated sample arithmetic', () => {
  test('preserves actual values, labels and endpoints, with unrounded adjacent changes and rates', () => {
    const input = sampleInput()
    const original = structuredClone(input)
    const result = calculateSampleChanges(input)
    expect(input).toEqual(original)
    expect(result).toMatchObject({ kind: 'sample-changes', inputsVerified: false, arithmetic: 'IEEE-754 binary64', timestamps })
    expect(result.intervals).toEqual([
      { from: timestamps[0], to: timestamps[1], elapsedMs: 5_000, elapsedSeconds: 5 },
      { from: timestamps[1], to: timestamps[2], elapsedMs: 5_000, elapsedSeconds: 5 },
    ])
    expect(result.series[0]).toEqual({ key: 'sgA', unit: 'kg', values: receiverA, changes: [
      { change: 29.907575088371232, ratePerSecond: 5.981515017674246 },
      { change: 64.83310415925371, ratePerSecond: 12.966620831850742 },
    ] })
    expect(result.series[1]!.changes[0]).toEqual({ change: 19.900251706196286, ratePerSecond: 3.980050341239257 })
    expect(result).not.toHaveProperty('quality')
    expect(result).not.toHaveProperty('criterionStatus')
    expect(result).not.toHaveProperty('modelDefinition')
  })

  test('uses actual timestamps rather than treating a six-second historian interval as five seconds', () => {
    const result = calculateSampleChanges({ timestamps: ['2026-07-12T04:01:09.043Z', timestamps[1]], series: [{ key: 'receiver', values: [10, 22] }] })
    expect(result.intervals[0]!.elapsedMs).toBe(6_000)
    expect(result.series[0]).toEqual({ key: 'receiver', values: [10, 22], changes: [{ change: 12, ratePerSecond: 2 }] })
  })

  test('compares actual instants with explicit offsets without altering the supplied strings', () => {
    const supplied = ['2026-07-12T06:01:10.043+02:00', timestamps[1]!]
    expect(calculateSampleChanges({ timestamps: supplied, series: [{ key: 'x', unit: 'caller-unit/s', values: [2, -3] }] })).toMatchObject({
      timestamps: supplied,
      intervals: [{ from: supplied[0], to: supplied[1], elapsedMs: 5_000, elapsedSeconds: 5 }],
      series: [{ unit: 'caller-unit/s', changes: [{ change: -5, ratePerSecond: -1 }] }],
    })
  })

  test('retains ordinary IEEE-754 behavior and permits zero change', () => {
    const result = calculateSampleChanges({ timestamps: timestamps.slice(0, 2), series: [
      { key: 'fraction', values: [0.1, 0.3] }, { key: 'constant', values: [42, 42] },
    ] })
    expect(result.series[0]!.changes[0]!.change).toBe(0.3 - 0.1)
    expect(result.series[1]!.changes[0]).toEqual({ change: 0, ratePerSecond: 0 })
  })

  test.each([
    '2026-02-30T04:01:10.043Z', '2025-02-29T04:01:10.043Z', '2026-13-12T04:01:10.043Z',
    '2026-07-12T24:01:10.043Z', '2026-07-12T04:01:60.043Z', '2026-07-12T04:01:10.0431Z',
    '2026-07-12T04:01:10.0430Z', '2026-07-12T04:01:10Z', '2026-07-12T04:01:10.043', 'not a date',
  ])('rejects invalid or precision-losing timestamp %s', timestamp => {
    expect(() => calculateSampleChanges({ timestamps: [timestamp, timestamps[1]], series: [{ key: 'x', values: [1, 2] }] })).toThrow()
  })

  test.each([
    [timestamps[0], timestamps[0]],
    [timestamps[1], timestamps[0]],
    [timestamps[0], '2026-07-12T06:01:10.043+02:00'],
  ])('rejects equal or reversed actual instants without sorting', (from, to) => {
    expect(() => calculateSampleChanges({ timestamps: [from, to], series: [{ key: 'x', values: [1, 2] }] })).toThrow('strictly increasing')
  })

  test('rejects mismatched samples, duplicate or ambiguous keys and unknown expression fields', () => {
    expect(() => calculateSampleChanges({ ...sampleInput(), series: [{ key: 'x', values: [1, 2] }] })).toThrow('one value per timestamp')
    expect(() => calculateSampleChanges({ timestamps, series: [0, 1].map(() => ({ key: 'x', values: [1, 2, 3] })) })).toThrow('unique')
    for (const key of ['', ' ', ' x', 'x ']) expect(() => calculateSampleChanges({ timestamps, series: [{ key, values: [1, 2, 3] }] })).toThrow()
    expect(() => calculateSampleChanges({ ...sampleInput(), expression: 'fetch(secret)' })).toThrow()
    expect(() => calculateSampleChanges({ timestamps: [], series: [] })).toThrow()
  })

  test.each([NaN, Infinity, -Infinity])('rejects nonfinite supplied value %s', value => {
    expect(sampleChangesInputSchema.safeParse({ timestamps: timestamps.slice(0, 2), series: [{ key: 'x', values: [0, value] }] }).success).toBe(false)
  })

  test('rejects finite-input subtraction and rate overflow rather than emitting null or clipping', () => {
    expect(() => calculateSampleChanges({ timestamps: timestamps.slice(0, 2), series: [{ key: 'x', values: [-Number.MAX_VALUE, Number.MAX_VALUE] }] })).toThrow('nonfinite')
    expect(() => calculateSampleChanges({ timestamps: [timestamps[0], '2026-07-12T04:01:10.044Z'], series: [{ key: 'x', values: [0, Number.MAX_VALUE] }] })).toThrow('nonfinite')
  })
})
