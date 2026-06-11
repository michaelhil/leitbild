import type { GeoJsonPoint } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import {
  horizontalOffsetMeters,
  lonLatFromMeterOffset,
  metersPerDegreeLonAt,
} from '../../core/spatial/local-frame.ts'

export { metersPerDegreeLonAt }

export interface LocalOffsetM {
  readonly eastM: number
  readonly northM: number
}

export interface BabylonHorizontalVector {
  readonly xEast: number
  readonly zSouth: number
}

export interface HorizontalVelocityMps {
  readonly eastMps: number
  readonly northMps: number
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

export const offsetMeters = (from: GeoJsonPoint, to: GeoJsonPoint): LocalOffsetM =>
  horizontalOffsetMeters(
    { lon: from.coordinates[0], lat: from.coordinates[1] },
    { lon: to.coordinates[0], lat: to.coordinates[1] },
  )

export const movePointByMeters = (
  point: GeoJsonPoint,
  offset: LocalOffsetM,
): GeoJsonPoint => {
  const next = lonLatFromMeterOffset({ lon: point.coordinates[0], lat: point.coordinates[1] }, offset)
  return geoPointFromLonLat(next.lon, next.lat)
}

export const horizontalDistanceM = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const offset = offsetMeters(from, to)
  return Math.hypot(offset.eastM, offset.northM)
}

export const bearingDeg = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const offset = offsetMeters(from, to)
  return normalizeAngleDeg(Math.atan2(offset.eastM, offset.northM) * 180 / Math.PI)
}

export const babylonYawRadForHeadingDeg = (
  headingDeg: number,
): number =>
  Math.PI - normalizeAngleDeg(headingDeg) * Math.PI / 180

export const babylonYawRateRadPerSecForHeadingRateDeg = (
  headingRateDegPerSec: number,
): number =>
  -headingRateDegPerSec * Math.PI / 180

export const babylonForwardVectorForHeadingDeg = (
  headingDeg: number,
): BabylonHorizontalVector => {
  const yawRad = babylonYawRadForHeadingDeg(headingDeg)
  return {
    xEast: Math.sin(yawRad),
    zSouth: Math.cos(yawRad),
  }
}

export const babylonRightVectorForHeadingDeg = (
  headingDeg: number,
): BabylonHorizontalVector => {
  const yawRad = babylonYawRadForHeadingDeg(headingDeg)
  return {
    xEast: -Math.cos(yawRad),
    zSouth: Math.sin(yawRad),
  }
}

export const horizontalVelocityFromBabylonBodyFrame = (config: {
  readonly headingDeg: number
  readonly forwardMps: number
  readonly rightMps: number
}): HorizontalVelocityMps => {
  const forward = babylonForwardVectorForHeadingDeg(config.headingDeg)
  const right = babylonRightVectorForHeadingDeg(config.headingDeg)
  const xEast = forward.xEast * config.forwardMps + right.xEast * config.rightMps
  const zSouth = forward.zSouth * config.forwardMps + right.zSouth * config.rightMps
  return {
    eastMps: xEast,
    northMps: -zSouth,
  }
}

export const bodyVelocityInBabylonFrame = (config: {
  readonly headingDeg: number
  readonly eastMps: number
  readonly northMps: number
}): {
  readonly forwardMps: number
  readonly rightMps: number
} => {
  const forward = babylonForwardVectorForHeadingDeg(config.headingDeg)
  const right = babylonRightVectorForHeadingDeg(config.headingDeg)
  const zSouthMps = -config.northMps
  return {
    forwardMps: config.eastMps * forward.xEast + zSouthMps * forward.zSouth,
    rightMps: config.eastMps * right.xEast + zSouthMps * right.zSouth,
  }
}
