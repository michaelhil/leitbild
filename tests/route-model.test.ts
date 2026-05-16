import { describe, expect, test } from 'bun:test'
import type { GeoJsonLineString } from '../src/core/model/index.ts'
import {
  advanceAlongRoute,
  geoPointFromLonLat,
  remainingDistanceAlongRoute,
  remainingRouteGeometry,
} from '../src/core/model/index.ts'

const route: GeoJsonLineString = {
  type: 'LineString',
  coordinates: [
    geoPointFromLonLat(10.0, 59.0).coordinates,
    geoPointFromLonLat(10.0, 59.0001).coordinates,
    geoPointFromLonLat(10.0, 59.0002).coordinates,
  ],
}

describe('route model helpers', () => {
  test('advances across multiple dense route segments using one movement budget', () => {
    const currentPoint = geoPointFromLonLat(10.0, 59.0)
    const advanced = advanceAlongRoute({
      currentPoint,
      route,
      segmentIndex: 1,
      metersToMove: 15,
    })

    expect(advanced.point.coordinates[1]).toBeGreaterThan(59.0001)
    expect(advanced.advancedDistanceM).toBeGreaterThan(14.9)
    expect(advanced.advancedDistanceM).toBeLessThanOrEqual(15)
  })

  test('derives remaining route from current point and future route coordinates', () => {
    const currentPoint = geoPointFromLonLat(10.0, 59.00005)
    const remaining = remainingRouteGeometry(route, currentPoint, 1)
    const remainingDistance = remainingDistanceAlongRoute(route, currentPoint, 1)

    expect(remaining?.coordinates[0]).toEqual(currentPoint.coordinates)
    expect(remaining?.coordinates[1]).toEqual(route.coordinates[1])
    expect(remainingDistance).toBeGreaterThan(0)
  })
})
