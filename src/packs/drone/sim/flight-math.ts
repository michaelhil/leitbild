import type { GeoJsonPoint } from '../../../core/model/index.ts'
import { geoPointFromLonLat } from '../../../core/model/index.ts'

const metersPerDegreeLat = 111_320

export interface LocalOffsetM {
  readonly eastM: number
  readonly northM: number
}

export const normalizeAngleDeg = (value: number): number => {
  const wrapped = value % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

export const shortestAngleDeltaDeg = (fromDeg: number, toDeg: number): number => {
  const delta = normalizeAngleDeg(toDeg) - normalizeAngleDeg(fromDeg)
  if (delta > 180) return delta - 360
  if (delta < -180) return delta + 360
  return delta
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export const limitRate = (current: number, target: number, maxDelta: number): number => {
  const delta = target - current
  if (Math.abs(delta) <= maxDelta) return target
  return current + Math.sign(delta) * maxDelta
}

export const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

export const offsetMeters = (from: GeoJsonPoint, to: GeoJsonPoint): LocalOffsetM => {
  const lat = (from.coordinates[1] + to.coordinates[1]) / 2
  return {
    eastM: (to.coordinates[0] - from.coordinates[0]) * metersPerDegreeLonAt(lat),
    northM: (to.coordinates[1] - from.coordinates[1]) * metersPerDegreeLat,
  }
}

export const movePointByMeters = (
  point: GeoJsonPoint,
  offset: LocalOffsetM,
): GeoJsonPoint =>
  geoPointFromLonLat(
    point.coordinates[0] + offset.eastM / metersPerDegreeLonAt(point.coordinates[1]),
    point.coordinates[1] + offset.northM / metersPerDegreeLat,
  )

export const horizontalDistanceM = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const offset = offsetMeters(from, to)
  return Math.hypot(offset.eastM, offset.northM)
}

export const bearingDeg = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const offset = offsetMeters(from, to)
  return normalizeAngleDeg(Math.atan2(offset.eastM, offset.northM) * 180 / Math.PI)
}
