import { describe, expect, test } from 'bun:test'
import { geoJsonPointSchema, geoJsonPolygonSchema, geoPointFromLonLat } from '../src/core/model/index.ts'

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

  test('requires GeoJSON polygon rings to be explicitly closed', () => {
    const closed = {
      type: 'Polygon',
      coordinates: [[
        geoPointFromLonLat(10, 59).coordinates,
        geoPointFromLonLat(11, 59).coordinates,
        geoPointFromLonLat(11, 60).coordinates,
        geoPointFromLonLat(10, 59).coordinates,
      ]],
    }
    const open = {
      type: 'Polygon',
      coordinates: [[
        geoPointFromLonLat(10, 59).coordinates,
        geoPointFromLonLat(11, 59).coordinates,
        geoPointFromLonLat(11, 60).coordinates,
        geoPointFromLonLat(10, 60).coordinates,
      ]],
    }

    expect(geoJsonPolygonSchema.parse(closed).coordinates[0]?.at(-1)?.map(Number)).toEqual(closed.coordinates[0]?.[0]?.map(Number))
    expect(() => geoJsonPolygonSchema.parse(open)).toThrow('GeoJSON polygon rings must repeat the first coordinate')
  })
})
