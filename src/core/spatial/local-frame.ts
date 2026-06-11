export interface LonLat {
  readonly lon: number
  readonly lat: number
}

export interface LocalFramePoint {
  readonly x: number
  readonly z: number
}

export interface LocalMeterOffset {
  readonly eastM: number
  readonly northM: number
}

export const metersPerDegreeLat = 111_320

export const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

export const localPointFromLonLat = (
  lon: number,
  lat: number,
  origin: LonLat,
): LocalFramePoint => ({
  x: (lon - origin.lon) * metersPerDegreeLonAt(origin.lat),
  z: -(lat - origin.lat) * metersPerDegreeLat,
})

export const lonLatFromLocalPoint = (
  point: LocalFramePoint,
  origin: LonLat,
): LonLat => ({
  lon: origin.lon + point.x / metersPerDegreeLonAt(origin.lat),
  lat: origin.lat - point.z / metersPerDegreeLat,
})

export const horizontalOffsetMeters = (
  from: LonLat,
  to: LonLat,
): LocalMeterOffset => {
  const lat = (from.lat + to.lat) / 2
  return {
    eastM: (to.lon - from.lon) * metersPerDegreeLonAt(lat),
    northM: (to.lat - from.lat) * metersPerDegreeLat,
  }
}

export const lonLatFromMeterOffset = (
  origin: LonLat,
  offset: LocalMeterOffset,
): LonLat => ({
  lon: origin.lon + offset.eastM / metersPerDegreeLonAt(origin.lat),
  lat: origin.lat + offset.northM / metersPerDegreeLat,
})
