import { describe, expect, test } from 'bun:test'
import { anchoredScroll, boundedZoom, fitDiagramScale } from './viewport.ts'

describe('diagram viewing geometry', () => {
  test('fit respects width and height and does not unnecessarily enlarge a small graph', () => {
    expect(fitDiagramScale({ width: 5000, height: 200 }, { width: 500, height: 400 })).toBe(0.1)
    expect(fitDiagramScale({ width: 100, height: 3000 }, { width: 500, height: 300 })).toBe(0.1)
    expect(fitDiagramScale({ width: 100, height: 100 }, { width: 500, height: 300 })).toBe(1)
    expect(fitDiagramScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1)
  })

  test('zoom keeps the same diagram point under the viewport anchor', () => {
    const oldScale = 0.5, newScale = 2, scroll = 400, anchor = 200
    const next = anchoredScroll(scroll, anchor, oldScale, newScale)
    expect((next + anchor) / newScale).toBe((scroll + anchor) / oldScale)
    expect(anchoredScroll(0, 200, 1, 0.5)).toBe(0)
    expect(boundedZoom(1000)).toBe(16)
    expect(boundedZoom(0)).toBeGreaterThan(0)
  })
})
