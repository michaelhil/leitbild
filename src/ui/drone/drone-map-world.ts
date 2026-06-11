export {
  loadDroneWorldTerrainStatus,
  type DroneWorldTerrainStatus,
} from './drone-world-capabilities.ts'

export interface DroneWorldCenter {
  readonly lon: number
  readonly lat: number
}

export interface DroneWorldPoint {
  readonly x: number
  readonly z: number
}

const metersPerDegreeLat = 111_320

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

export const localPointFromLonLat = (
  lon: number,
  lat: number,
  center: DroneWorldCenter,
): DroneWorldPoint => ({
  x: (lon - center.lon) * metersPerDegreeLonAt(center.lat),
  z: -(lat - center.lat) * metersPerDegreeLat,
})
