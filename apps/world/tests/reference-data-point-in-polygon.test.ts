import { describe, expect, test } from 'bun:test'
import { geometryBbox, pointInBbox, pointInPolygon } from '../src/reference-data/point-in-polygon.ts'
import type { GeoJsonGeometry } from '../src/reference-data/types.ts'

const square: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [[
    [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
  ]],
}

const squareWithHole: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
  ],
}

const multiTwoSquares: GeoJsonGeometry = {
  type: 'MultiPolygon',
  coordinates: [
    [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
    [[[20, 20], [25, 20], [25, 25], [20, 25], [20, 20]]],
  ],
}

describe('pointInPolygon', () => {
  test('inside a simple square', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true)
  })
  test('outside a simple square', () => {
    expect(pointInPolygon([15, 5], square)).toBe(false)
    expect(pointInPolygon([-1, 5], square)).toBe(false)
    expect(pointInPolygon([5, 15], square)).toBe(false)
  })
  test('on a vertex counts as inside', () => {
    expect(pointInPolygon([0, 0], square)).toBe(true)
    expect(pointInPolygon([10, 10], square)).toBe(true)
  })
  test('on an edge counts as inside', () => {
    expect(pointInPolygon([5, 0], square)).toBe(true)
    expect(pointInPolygon([10, 5], square)).toBe(true)
  })
  test('point in hole is outside', () => {
    expect(pointInPolygon([5, 5], squareWithHole)).toBe(false)
  })
  test('point on hole edge counts as inside (boundary preserved)', () => {
    expect(pointInPolygon([3, 5], squareWithHole)).toBe(true)
  })
  test('point inside outer but not in hole is inside', () => {
    expect(pointInPolygon([1, 1], squareWithHole)).toBe(true)
    expect(pointInPolygon([9, 9], squareWithHole)).toBe(true)
  })
  test('MultiPolygon: inside first polygon', () => {
    expect(pointInPolygon([2, 2], multiTwoSquares)).toBe(true)
  })
  test('MultiPolygon: inside second polygon', () => {
    expect(pointInPolygon([22, 22], multiTwoSquares)).toBe(true)
  })
  test('MultiPolygon: outside both polygons', () => {
    expect(pointInPolygon([15, 15], multiTwoSquares)).toBe(false)
  })
  test('non-polygon geometry returns false', () => {
    expect(pointInPolygon([0, 0], { type: 'Point', coordinates: [0, 0] })).toBe(false)
    expect(pointInPolygon([0, 0], { type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toBe(false)
  })
})

describe('geometryBbox', () => {
  test('polygon bbox', () => {
    expect(geometryBbox(square)).toEqual([0, 0, 10, 10])
  })
  test('MultiPolygon bbox covers all parts', () => {
    expect(geometryBbox(multiTwoSquares)).toEqual([0, 0, 25, 25])
  })
  test('Point bbox is degenerate', () => {
    expect(geometryBbox({ type: 'Point', coordinates: [5, 7] })).toEqual([5, 7, 5, 7])
  })
})

describe('pointInBbox', () => {
  test('inside', () => {
    expect(pointInBbox([5, 5], [0, 0, 10, 10])).toBe(true)
  })
  test('on edge', () => {
    expect(pointInBbox([0, 5], [0, 0, 10, 10])).toBe(true)
  })
  test('outside', () => {
    expect(pointInBbox([11, 5], [0, 0, 10, 10])).toBe(false)
  })
})
