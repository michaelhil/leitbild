import { describe, expect, test } from 'bun:test'
import { geoJsonPointSchema, geoPointFromLonLat } from '../src/core/model/index.ts'

describe('core geo model', () => {
  test('uses GeoJSON longitude-latitude coordinate order', () => {
    const point = geoPointFromLonLat(10.7522, 59.9139)
    expect(Number(point.coordinates[0])).toBe(10.7522)
    expect(Number(point.coordinates[1])).toBe(59.9139)
    expect(geoJsonPointSchema.parse(point).coordinates.map(Number)).toEqual([10.7522, 59.9139])
  })

  test('rejects latitude values in longitude slot only when outside longitude range', () => {
    expect(() => geoPointFromLonLat(200, 59.9139)).toThrow()
    expect(() => geoPointFromLonLat(10.7522, 95)).toThrow()
  })
})
