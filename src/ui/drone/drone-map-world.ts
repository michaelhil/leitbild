export interface DroneWorldCenter {
  readonly lon: number
  readonly lat: number
}

export interface DroneWorldPoint {
  readonly x: number
  readonly z: number
}

export type DroneWorldTerrainStatus =
  | {
      readonly status: 'available'
      readonly demEncoding: 'terrarium' | 'mapbox'
      readonly tileTemplate: string
      readonly tileJsonUrl: string
      readonly minZoom?: number
      readonly maxZoom?: number
      readonly tileSize?: 256 | 512
      readonly path?: string
    }
  | {
      readonly status: 'unavailable'
      readonly reason: string
      readonly path?: string
    }
  | {
      readonly status: 'unknown'
      readonly reason: string
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

const recordValue = (
  value: unknown,
): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null

const stringValue = (
  value: unknown,
): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const finiteNumberValue = (
  value: unknown,
): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const terrainStatusFromManifest = (
  value: unknown,
): DroneWorldTerrainStatus => {
  const manifest = recordValue(value)
  const tilesets = Array.isArray(manifest?.tilesets) ? manifest.tilesets : null
  if (!tilesets) return { status: 'unknown', reason: 'map capability manifest has no tilesets array' }
  const terrain = tilesets
    .map(recordValue)
    .find(tileset => tileset?.kind === 'terrain')
  if (!terrain) return { status: 'unavailable', reason: 'terrain capability is not advertised' }

  const availability = recordValue(terrain.availability)
  const artifact = recordValue(terrain.artifact)
  const availabilityStatus = stringValue(availability?.status)
  const path = stringValue(availability?.path)
  if (availabilityStatus === 'available') {
    const demEncoding = stringValue(artifact?.demEncoding)
    const tileTemplate = stringValue(artifact?.currentTileTemplate)
    const tileJsonUrl = stringValue(artifact?.tileJsonUrl)
    const minZoom = finiteNumberValue(artifact?.minZoom)
    const maxZoom = finiteNumberValue(artifact?.maxZoom)
    const tileSize = finiteNumberValue(artifact?.tileSize)
    if ((demEncoding !== 'terrarium' && demEncoding !== 'mapbox') || !tileTemplate || !tileJsonUrl) {
      return { status: 'unknown', reason: 'terrain capability is available but artifact metadata is incomplete' }
    }
    const parsedDemEncoding: 'terrarium' | 'mapbox' = demEncoding
    const parsedTileSize: 256 | 512 | undefined = tileSize === 256 || tileSize === 512 ? tileSize : undefined
    const shared = {
      demEncoding: parsedDemEncoding,
      tileTemplate,
      tileJsonUrl,
      ...(minZoom === null ? {} : { minZoom }),
      ...(maxZoom === null ? {} : { maxZoom }),
      ...(parsedTileSize === undefined ? {} : { tileSize: parsedTileSize }),
    }
    return path
      ? { status: 'available', ...shared, path }
      : { status: 'available', ...shared }
  }

  if (availabilityStatus === 'unavailable') {
    const reason = stringValue(availability?.error) ?? 'terrain PMTiles artifact is not present'
    return path
      ? { status: 'unavailable', reason, path }
      : { status: 'unavailable', reason }
  }

  return { status: 'unknown', reason: 'terrain capability has an invalid availability status' }
}

const loadMapCapabilityManifestBody = async (
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  const response = await fetch('/map/capabilities.json', signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`map capability query failed with HTTP ${response.status}`)
  return await response.json() as unknown
}

export const loadDroneWorldTerrainStatus = async (config: {
  readonly signal?: AbortSignal
} = {}): Promise<DroneWorldTerrainStatus> => {
  try {
    return terrainStatusFromManifest(await loadMapCapabilityManifestBody(config.signal))
  } catch (error) {
    if (config.signal?.aborted) throw error
    return {
      status: 'unavailable',
      reason: error instanceof Error ? `map capability query failed: ${error.message}` : `map capability query failed: ${String(error)}`,
    }
  }
}
