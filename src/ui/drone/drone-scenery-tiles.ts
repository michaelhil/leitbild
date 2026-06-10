import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'
import { TilesRenderer } from '3d-tiles-renderer/babylonjs'
import type { Tile } from '3d-tiles-renderer/core'
import {
  sceneryAssetFormat,
  sceneryAssetTilesetSchema,
  sceneryAssetTileEncoding,
  type SceneryTilesetFeatureCounts,
  type SceneryTilesetOrigin,
} from '../../map/scenery.ts'

export type DroneWorldSceneryTilesetStatus =
  | {
      readonly status: 'available'
      readonly tilesetUrl: string
      readonly tileTemplate: string
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

export interface DroneSceneryTilesetInfo {
  readonly tilesetUrl: string
  readonly origin: SceneryTilesetOrigin
  readonly bounds: {
    readonly minLon: number
    readonly minLat: number
    readonly maxLon: number
    readonly maxLat: number
  }
  readonly counts: SceneryTilesetFeatureCounts & {
    readonly bytes: number
    readonly writtenTileCount: number
  }
}

export interface DroneSceneryTilesRuntimeMetrics {
  readonly visibleTiles: number
  readonly activeTiles: number
  readonly loadedTiles: number
  readonly cachedBytes: number
  readonly loadProgress: number
  readonly failedTiles: number
}

export interface DroneSceneryTilesRenderer {
  readonly info: DroneSceneryTilesetInfo
  readonly update: () => void
  readonly metrics: () => DroneSceneryTilesRuntimeMetrics
  readonly dispose: () => void
}

interface TileContentMetadata {
  readonly byteLength?: number
  readonly featureCounts?: Partial<SceneryTilesetFeatureCounts>
}

interface TileNodeMetadata {
  readonly aggregateByteLength?: number
  readonly aggregateFeatureCounts?: Partial<SceneryTilesetFeatureCounts>
}

interface PatchedTilesRenderer extends TilesRenderer {
  calculateBytesUsed?: (tile: Tile) => number
  stats?: {
    readonly loaded?: number
    readonly failed?: number
  }
  readonly lruCache: TilesRenderer['lruCache'] & {
    readonly cachedBytes?: number
  }
}

const megabyte = 1024 * 1024

export const droneSceneryTileCacheBudget = Object.freeze({
  contentByteMultiplier: 1.25,
  aggregateByteMultiplier: 0.04,
  minTileCount: 260,
  maxTileCount: 420,
  minBytes: 512 * megabyte,
  maxBytes: 768 * megabyte,
  unloadPercent: 0.1,
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

const contentMetadataFor = (
  tile: Tile,
): TileContentMetadata | null => {
  const content = recordValue(tile.content)
  const extras = recordValue(content?.extras)
  return recordValue(extras?.leitbild) as TileContentMetadata | null
}

const nodeMetadataFor = (
  tile: Tile,
): TileNodeMetadata | null => {
  const extras = recordValue(tile.extras)
  return recordValue(extras?.leitbild) as TileNodeMetadata | null
}

export const estimateDroneSceneryTileBytesForCache = (
  tile: Tile,
): number => {
  const contentBytes = contentMetadataFor(tile)?.byteLength
  if (typeof contentBytes === 'number' && Number.isFinite(contentBytes) && contentBytes > 0) {
    return Math.max(1, Math.ceil(contentBytes * droneSceneryTileCacheBudget.contentByteMultiplier))
  }
  const aggregateBytes = nodeMetadataFor(tile)?.aggregateByteLength
  if (typeof aggregateBytes === 'number' && Number.isFinite(aggregateBytes) && aggregateBytes > 0) {
    return Math.max(1, Math.ceil(aggregateBytes * droneSceneryTileCacheBudget.aggregateByteMultiplier))
  }
  return 1
}

const sceneryStatusFromManifest = (
  value: unknown,
): DroneWorldSceneryTilesetStatus => {
  const manifest = recordValue(value)
  const tilesets = Array.isArray(manifest?.tilesets) ? manifest.tilesets : null
  if (!tilesets) return { status: 'unknown', reason: 'map capability manifest has no tilesets array' }
  const scenery = tilesets
    .map(recordValue)
    .find(tileset => tileset?.kind === 'scenery')
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
    if (format !== sceneryAssetFormat || tileEncoding !== sceneryAssetTileEncoding || !tilesetUrl || !tileTemplate) {
      return { status: 'unknown', reason: 'scenery capability is available but 3D Tiles metadata is incomplete' }
    }
    return path
      ? { status: 'available', tilesetUrl, tileTemplate, path }
      : { status: 'available', tilesetUrl, tileTemplate }
  }

  if (availabilityStatus === 'unavailable') {
    const reason = stringValue(availability?.error) ?? 'precompiled scenery tileset is not present'
    return path
      ? { status: 'unavailable', reason, path }
      : { status: 'unavailable', reason }
  }

  return { status: 'unknown', reason: 'scenery capability has an invalid availability status' }
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
    return sceneryStatusFromManifest(await loadMapCapabilityManifestBody(config.signal))
  } catch (error) {
    if (config.signal?.aborted) throw error
    return {
      status: 'unavailable',
      reason: error instanceof Error ? `map capability query failed: ${error.message}` : `map capability query failed: ${String(error)}`,
    }
  }
}

export const loadDroneSceneryTilesetInfo = async (config: {
  readonly status: Extract<DroneWorldSceneryTilesetStatus, { readonly status: 'available' }>
  readonly signal?: AbortSignal
}): Promise<DroneSceneryTilesetInfo> => {
  const response = await fetch(config.status.tilesetUrl, config.signal ? { signal: config.signal } : undefined)
  if (!response.ok) throw new Error(`scenery tileset query failed with HTTP ${response.status}`)
  const parsed = sceneryAssetTilesetSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error(`scenery tileset failed schema validation: ${parsed.error.message}`)
  const metadata = parsed.data.extras.leitbild
  return {
    tilesetUrl: config.status.tilesetUrl,
    origin: metadata.origin,
    bounds: metadata.bounds,
    counts: {
      polygons: metadata.counts.polygons,
      lines: metadata.counts.lines,
      labels: metadata.counts.labels,
      buildings: metadata.counts.buildings,
      roads: metadata.counts.roads,
      water: metadata.counts.water,
      vegetation: metadata.counts.vegetation,
      bytes: metadata.counts.bytes,
      writtenTileCount: metadata.counts.writtenTileCount,
    },
  }
}

const configureRendererBudgets = (
  tiles: PatchedTilesRenderer,
): void => {
  tiles.errorTarget = 11
  tiles.loadAncestors = false
  tiles.loadSiblings = false
  tiles.maxTilesProcessed = 420
  tiles.downloadQueue.maxJobs = 8
  tiles.parseQueue.maxJobs = 2
  tiles.lruCache.minSize = droneSceneryTileCacheBudget.minTileCount
  tiles.lruCache.maxSize = droneSceneryTileCacheBudget.maxTileCount
  tiles.lruCache.minBytesSize = droneSceneryTileCacheBudget.minBytes
  tiles.lruCache.maxBytesSize = droneSceneryTileCacheBudget.maxBytes
  tiles.lruCache.unloadPercent = droneSceneryTileCacheBudget.unloadPercent
  tiles.calculateBytesUsed = estimateDroneSceneryTileBytesForCache
}

export const createDroneSceneryTilesRenderer = (config: {
  readonly scene: Scene
  readonly info: DroneSceneryTilesetInfo
  readonly onStatus?: (message: string) => void
  readonly onError?: (message: string) => void
  readonly onModelLoaded?: (node: TransformNode) => void
}): DroneSceneryTilesRenderer => {
  const tiles = new TilesRenderer(config.info.tilesetUrl, config.scene) as PatchedTilesRenderer
  tiles.group.name = 'leitbild-scenery-3d-tiles'
  tiles.checkCollisions = false
  configureRendererBudgets(tiles)

  tiles.addEventListener('load-model', event => {
    config.onModelLoaded?.(event.scene)
  })
  tiles.addEventListener('tiles-load-start', () => {
    config.onStatus?.('3D Tiles scenery loading')
  })
  tiles.addEventListener('tiles-load-end', () => {
    config.onStatus?.('3D Tiles scenery ready')
  })
  tiles.addEventListener('load-error', event => {
    const url = String(event.url)
    const detail = event.error instanceof Error ? event.error.message : String(event.error)
    config.onError?.(`3D Tiles scenery failed at ${url}: ${detail}`)
  })

  return {
    info: config.info,
    update: (): void => {
      tiles.update()
    },
    metrics: (): DroneSceneryTilesRuntimeMetrics => ({
      visibleTiles: tiles.visibleTiles.size,
      activeTiles: tiles.activeTiles.size,
      loadedTiles: tiles.stats?.loaded ?? tiles.activeTiles.size,
      cachedBytes: finiteNumberValue(tiles.lruCache.cachedBytes) ?? 0,
      loadProgress: tiles.loadProgress,
      failedTiles: tiles.stats?.failed ?? 0,
    }),
    dispose: (): void => {
      tiles.dispose()
    },
  }
}
