import {
  sceneryAssetFormat,
  sceneryAssetTileEncoding,
} from '../../map/scenery.ts'

export type DroneWorldSceneryTilesetStatus =
  | {
      readonly status: 'available'
      readonly tilesetUrl: string
      readonly tileTemplate: string
      readonly roadTileTemplate: string
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

const tilesetsFromManifest = (
  value: unknown,
): ReadonlyArray<Record<string, unknown>> | null => {
  const manifest = recordValue(value)
  const tilesets = Array.isArray(manifest?.tilesets) ? manifest.tilesets : null
  return tilesets?.map(recordValue).filter((tileset): tileset is Record<string, unknown> => tileset !== null) ?? null
}

export const sceneryStatusFromMapCapabilityManifest = (
  value: unknown,
): DroneWorldSceneryTilesetStatus => {
  const tilesets = tilesetsFromManifest(value)
  if (!tilesets) return { status: 'unknown', reason: 'map capability manifest has no tilesets array' }
  const scenery = tilesets.find(tileset => tileset.kind === 'scenery')
  if (!scenery) return { status: 'unavailable', reason: 'scenery capability is not advertised' }

  const availability = recordValue(scenery.availability)
  const artifact = recordValue(scenery.artifact)
  const availabilityStatus = stringValue(availability?.status)
  const path = stringValue(availability?.path)
  if (availabilityStatus === 'available') {
    const tileEncoding = stringValue(artifact?.tileEncoding)
    const format = stringValue(artifact?.format)
    const tilesetUrl = stringValue(artifact?.tilesetUrl)
    const tileTemplate = stringValue(artifact?.currentTileTemplate)
    const roadTileTemplate = stringValue(artifact?.roadTileTemplate)
    if (format !== sceneryAssetFormat || tileEncoding !== sceneryAssetTileEncoding || !tilesetUrl || !tileTemplate || !roadTileTemplate) {
      return { status: 'unknown', reason: 'scenery capability is available but 3D Tiles metadata is incomplete' }
    }
    return path
      ? { status: 'available', tilesetUrl, tileTemplate, roadTileTemplate, path }
      : { status: 'available', tilesetUrl, tileTemplate, roadTileTemplate }
  }

  if (availabilityStatus === 'unavailable') {
    const reason = stringValue(availability?.error) ?? 'precompiled scenery tileset is not present'
    return path
      ? { status: 'unavailable', reason, path }
      : { status: 'unavailable', reason }
  }

  return { status: 'unknown', reason: 'scenery capability has an invalid availability status' }
}

export const terrainStatusFromMapCapabilityManifest = (
  value: unknown,
): DroneWorldTerrainStatus => {
  const tilesets = tilesetsFromManifest(value)
  if (!tilesets) return { status: 'unknown', reason: 'map capability manifest has no tilesets array' }
  const terrain = tilesets.find(tileset => tileset.kind === 'terrain')
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

export const loadDroneWorldSceneryTilesetStatus = async (config: {
  readonly signal?: AbortSignal
} = {}): Promise<DroneWorldSceneryTilesetStatus> => {
  try {
    return sceneryStatusFromMapCapabilityManifest(await loadMapCapabilityManifestBody(config.signal))
  } catch (error) {
    if (config.signal?.aborted) throw error
    return {
      status: 'unavailable',
      reason: error instanceof Error ? `map capability query failed: ${error.message}` : `map capability query failed: ${String(error)}`,
    }
  }
}

export const loadDroneWorldTerrainStatus = async (config: {
  readonly signal?: AbortSignal
} = {}): Promise<DroneWorldTerrainStatus> => {
  try {
    return terrainStatusFromMapCapabilityManifest(await loadMapCapabilityManifestBody(config.signal))
  } catch (error) {
    if (config.signal?.aborted) throw error
    return {
      status: 'unavailable',
      reason: error instanceof Error ? `map capability query failed: ${error.message}` : `map capability query failed: ${String(error)}`,
    }
  }
}
