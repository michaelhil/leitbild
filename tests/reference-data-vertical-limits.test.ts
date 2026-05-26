import { describe, expect, test } from 'bun:test'
import { normaliseVerticalLimit } from '../src/reference-data/sources/vertical-limits.ts'

describe('normaliseVerticalLimit', () => {
  test('GND surface: 0 ft GND -> 0m GND, label "GND"', () => {
    const r = normaliseVerticalLimit({ value: 0, unit: 'FT', referenceDatum: 'GND' })
    expect(r.metres).toBe(0)
    expect(r.reference).toBe('GND')
    expect(r.label).toBe('GND')
  })

  test('feet MSL: 1500 ft MSL -> 457.2m MSL', () => {
    const r = normaliseVerticalLimit({ value: 1500, unit: 'FT', referenceDatum: 'MSL' })
    expect(r.metres).toBeCloseTo(457.2, 1)
    expect(r.reference).toBe('MSL')
    expect(r.label).toBe('1500 ft MSL')
  })

  test('flight level: FL095 -> 9500 ft -> ~2895.6m STD', () => {
    const r = normaliseVerticalLimit({ value: 95, unit: 'FL', referenceDatum: 'STD' })
    expect(r.metres).toBeCloseTo(2895.6, 1)
    expect(r.reference).toBe('STD')
    expect(r.label).toBe('FL095')
  })

  test('flight level without referenceDatum defaults to STD', () => {
    const r = normaliseVerticalLimit({ value: 245, unit: 'FL', referenceDatum: null })
    expect(r.reference).toBe('STD')
    expect(r.label).toBe('FL245')
  })

  test('metres MSL: 1000 m MSL -> 1000m MSL', () => {
    const r = normaliseVerticalLimit({ value: 1000, unit: 'M', referenceDatum: 'MSL' })
    expect(r.metres).toBe(1000)
    expect(r.label).toBe('1000 m MSL')
  })

  test('unlimited: null/null/null -> null metres, UNL ref, "UNL" label', () => {
    const r = normaliseVerticalLimit({ value: null, unit: null, referenceDatum: null })
    expect(r.metres).toBeNull()
    expect(r.reference).toBe('UNL')
    expect(r.label).toBe('UNL')
  })

  test('unlimited sentinel: very large value treated as UNL', () => {
    const r = normaliseVerticalLimit({ value: 99999, unit: 'FT', referenceDatum: 'STD' })
    expect(r.metres).toBeNull()
    expect(r.reference).toBe('UNL')
    expect(r.label).toBe('UNL')
  })

  test('throws on unknown referenceDatum', () => {
    expect(() =>
      normaliseVerticalLimit({ value: 1000, unit: 'FT', referenceDatum: 'WEIRD' as never }),
    ).toThrow(/referenceDatum/i)
  })

  test('null value with any unit/datum is treated as unlimited', () => {
    // Intentional design: missing numeric value means no numeric ceiling/floor.
    // Documented in vertical-limits.ts.
    const r = normaliseVerticalLimit({ value: null, unit: 'FT', referenceDatum: 'MSL' })
    expect(r.metres).toBeNull()
    expect(r.reference).toBe('UNL')
  })
})
