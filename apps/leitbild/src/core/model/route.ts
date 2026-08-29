import type { GeoJsonLineString, GeoJsonPoint, GeoJsonPosition2D, Meters } from './geo.ts'
import { geoPointFromLonLat, meters } from './geo.ts'

export interface RouteAdvance {
  readonly point: GeoJsonPoint
  readonly segmentIndex: number
  readonly headingTarget: GeoJsonPoint
  readonly advancedDistanceM: Meters
}

export const pointFromPosition = (position: GeoJsonPosition2D): GeoJsonPoint => ({
  type: 'Point',
  coordinates: position,
})

export const routeDistanceMeters = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  const meanLatRad = ((fromLat + toLat) / 2) * Math.PI / 180
  const dx = (toLon - fromLon) * 111_320 * Math.cos(meanLatRad)
  const dy = (toLat - fromLat) * 110_540
  return Math.sqrt(dx * dx + dy * dy)
}

export const moveTowardsPoint = (from: GeoJsonPoint, to: GeoJsonPoint, metersToMove: number): GeoJsonPoint => {
  const distance = routeDistanceMeters(from, to)
  if (distance <= metersToMove || distance === 0) return to
  const ratio = metersToMove / distance
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  return geoPointFromLonLat(fromLon + (toLon - fromLon) * ratio, fromLat + (toLat - fromLat) * ratio)
}

const clampSegmentIndex = (route: GeoJsonLineString, segmentIndex: number): number =>
  Math.max(0, Math.min(segmentIndex, route.coordinates.length - 1))

export const advanceAlongRoute = (config: {
  readonly currentPoint: GeoJsonPoint
  readonly route: GeoJsonLineString
  readonly segmentIndex: number
  readonly metersToMove: number
}): RouteAdvance => {
  if (config.route.coordinates.length === 0 || config.metersToMove <= 0) {
    return {
      point: config.currentPoint,
      segmentIndex: Math.max(0, config.segmentIndex),
      headingTarget: config.currentPoint,
      advancedDistanceM: meters(0),
    }
  }
  let point = config.currentPoint
  let segmentIndex = clampSegmentIndex(config.route, config.segmentIndex)
  let remainingMeters = config.metersToMove
  let advancedDistanceM = 0
  let headingTarget = pointFromPosition(config.route.coordinates[segmentIndex] ?? config.currentPoint.coordinates)

  while (remainingMeters > 0 && segmentIndex < config.route.coordinates.length) {
    const targetPoint = pointFromPosition(config.route.coordinates[segmentIndex] ?? point.coordinates)
    headingTarget = targetPoint
    const segmentDistance = routeDistanceMeters(point, targetPoint)
    if (segmentDistance > remainingMeters) {
      return {
        point: moveTowardsPoint(point, targetPoint, remainingMeters),
        segmentIndex,
        headingTarget,
        advancedDistanceM: meters(advancedDistanceM + remainingMeters),
      }
    }
    point = targetPoint
    remainingMeters -= segmentDistance
    advancedDistanceM += segmentDistance
    segmentIndex += 1
  }

  return {
    point,
    segmentIndex: clampSegmentIndex(config.route, segmentIndex),
    headingTarget,
    advancedDistanceM: meters(advancedDistanceM),
  }
}

export const remainingDistanceAlongRoute = (
  route: GeoJsonLineString,
  currentPoint: GeoJsonPoint,
  segmentIndex: number,
): Meters => {
  if (route.coordinates.length === 0) return meters(0)
  const startIndex = clampSegmentIndex(route, segmentIndex)
  let distance = routeDistanceMeters(currentPoint, pointFromPosition(route.coordinates[startIndex] ?? currentPoint.coordinates))
  for (let index = startIndex; index < route.coordinates.length - 1; index++) {
    const from = pointFromPosition(route.coordinates[index] ?? currentPoint.coordinates)
    const to = pointFromPosition(route.coordinates[index + 1] ?? currentPoint.coordinates)
    distance += routeDistanceMeters(from, to)
  }
  return meters(distance)
}

export const remainingRouteGeometry = (
  route: GeoJsonLineString,
  currentPoint: GeoJsonPoint,
  segmentIndex: number,
): GeoJsonLineString | null => {
  if (route.coordinates.length === 0) return null
  const startIndex = clampSegmentIndex(route, segmentIndex)
  const coordinates = [
    currentPoint.coordinates,
    ...route.coordinates.slice(startIndex),
  ]
  if (coordinates.length < 2) return null
  return {
    type: 'LineString',
    coordinates,
  }
}
