import { describe, expect, test } from 'bun:test'
import {
  horizontalOffsetMeters,
  localPointFromLonLat,
  lonLatFromLocalPoint,
  lonLatFromMeterOffset,
  metersPerDegreeLonAt,
} from '../src/core/spatial/local-frame.ts'

describe('local spatial frame', () => {
  test('round-trips lon lat through a local Babylon-style X/Z point', () => {
    const origin = { lon: 10.75, lat: 59.91 }
    const point = { lon: 10.752, lat: 59.912 }

    const local = localPointFromLonLat(point.lon, point.lat, origin)
    const roundTrip = lonLatFromLocalPoint(local, origin)

    expect(roundTrip.lon).toBeCloseTo(point.lon, 8)
    expect(roundTrip.lat).toBeCloseTo(point.lat, 8)
    expect(local.x).toBeGreaterThan(0)
    expect(local.z).toBeLessThan(0)
  })

  test('keeps east/north meter offsets consistent with lon lat offsets', () => {
    const origin = { lon: 10.75, lat: 59.91 }
    const eastM = metersPerDegreeLonAt(origin.lat) * 0.001
    const moved = lonLatFromMeterOffset(origin, { eastM, northM: 111.32 })
    const offset = horizontalOffsetMeters(origin, moved)

    expect(moved.lon).toBeCloseTo(10.751, 8)
    expect(moved.lat).toBeCloseTo(59.911, 8)
    expect(offset.eastM).toBeCloseTo(eastM, 1)
    expect(offset.northM).toBeCloseTo(111.32, 3)
  })
})
