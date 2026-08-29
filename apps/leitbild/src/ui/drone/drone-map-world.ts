import {
  localPointFromLonLat as localFramePointFromLonLat,
  type LocalFramePoint,
  type LonLat,
} from '../../core/spatial/local-frame.ts'

export {
  loadDroneWorldTerrainStatus,
  type DroneWorldTerrainStatus,
} from './drone-world-capabilities.ts'

export type DroneWorldCenter = LonLat
export type DroneWorldPoint = LocalFramePoint

export const localPointFromLonLat = (
  lon: number,
  lat: number,
  center: DroneWorldCenter,
): DroneWorldPoint =>
  localFramePointFromLonLat(lon, lat, center)
