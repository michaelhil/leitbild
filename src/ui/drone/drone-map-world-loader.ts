import {
  loadCachedDroneMapWorld,
  loadDroneWorldTerrainStatus,
  type DroneMapWorldSnapshot,
  type DroneWorldCenter,
  type DroneWorldTerrainStatus,
} from './drone-map-world.ts'
import { loadDroneTerrainModel, type DroneTerrainModel } from './drone-terrain.ts'

export type DroneMapWorldLoadSource = 'asset-tiles'

export interface DroneMapWorldLoadResult {
  readonly snapshot: DroneMapWorldSnapshot
  readonly source: DroneMapWorldLoadSource
  readonly terrain: DroneWorldTerrainStatus
  readonly terrainModel: DroneTerrainModel
}

const safeLoadTerrainModel = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly terrain: DroneWorldTerrainStatus
}): Promise<DroneTerrainModel> => {
  try {
    return await loadDroneTerrainModel(config)
  } catch (err) {
    return {
      kind: 'flat',
      reason: err instanceof Error ? `terrain DEM unavailable: ${err.message}` : `terrain DEM unavailable: ${String(err)}`,
    }
  }
}

export const loadDroneMapWorldForScene = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM?: number
  readonly zoom?: number
  readonly zooms?: ReadonlyArray<number>
}): Promise<DroneMapWorldLoadResult> => {
  const radiusM = config.radiusM ?? 4_250
  const zoom = config.zoom ?? 14
  const snapshot = await loadCachedDroneMapWorld({
    center: config.center,
    radiusM,
    ...(config.zooms === undefined ? { zoom } : { zooms: config.zooms }),
  })
  const terrain = await loadDroneWorldTerrainStatus()
  const terrainModel = await safeLoadTerrainModel({ center: config.center, radiusM, terrain })
  return { snapshot, source: 'asset-tiles', terrain, terrainModel }
}
