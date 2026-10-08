import { describe, expect, test } from 'bun:test'
import {
  appendPoint,
  formatValue,
  HOLD_GAP_MS,
  paddedDomain,
  rawDomain,
  stepPath,
  tickLabels,
  timeTicks,
  valueTicks,
} from '../src/ui/embed/composed-display/trend-geometry.ts'

describe('composed display trend geometry', () => {
  test('pads a fixed domain and never collapses a flat signal', () => {
    expect(rawDomain([])).toBeNull()
    expect(paddedDomain({ min: 20, max: 70 })).toEqual({ min: 16, max: 74 })
    expect(paddedDomain({ min: 15.5, max: 15.5 })).toEqual({ min: 14.5, max: 16.5 })
  })

  test('chooses readable value ticks', () => {
    expect(valueTicks({ min: 13.6, max: 16.5 })).toEqual([14, 15, 16])
    expect(valueTicks({ min: 16, max: 74 })).toEqual([20, 40, 60])
  })

  test('labels time relative to now', () => {
    expect(timeTicks(1_000_000, 600_000).map(tick => tick.label)).toEqual(['−10 min', '−8 min', '−6 min', '−4 min', '−2 min', 'now'])
    expect(timeTicks(1_000_000, 120_000).map(tick => tick.label)).toEqual(['−2 min', '−90 s', '−1 min', '−30 s', 'now'])
  })

  test('keeps points ordered within the window plus the hold gap', () => {
    const points = [{ t: 0, v: 1 }, { t: 100_000, v: 2 }, { t: 200_000, v: 3 }]
    expect(appendPoint(points, { t: 300_000, v: 4 }, 250_000).map(point => point.t)).toEqual([200_000, 300_000])
    expect(appendPoint(points, { t: 150_000, v: 9 }, 0).map(point => point.t)).toEqual([0, 100_000, 150_000])
  })

  test('holds sampled values and breaks across long gaps', () => {
    const x = (t: number) => t / 1000
    const y = (v: number) => v
    const window = { start: 0, end: 300_000 }
    expect(stepPath([{ t: 0, v: 5 }, { t: 60_000, v: 6 }], x, y, window)).toBe('M0.0 5.0 L60.0 5.0 L60.0 6.0 L150.0 6.0')
    const gap = stepPath([{ t: 0, v: 5 }, { t: HOLD_GAP_MS + 60_000, v: 6 }], x, y, window)
    expect(gap).toBe('M0.0 5.0 L90.0 5.0 M150.0 6.0 L240.0 6.0')
  })

  test('formats values and units for operators', () => {
    expect(formatValue(15.512)).toBe('15.5')
    expect(formatValue(3412.4)).toBe('3412')
    expect(formatValue(0.0123)).toBe('0.012')
    expect(tickLabels([5, 10, 15])).toEqual(['5', '10', '15'])
    expect(tickLabels([0.5, 1, 1.5])).toEqual(['0.5', '1.0', '1.5'])
  })
})
