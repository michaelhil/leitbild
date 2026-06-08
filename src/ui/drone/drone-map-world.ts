import {
  sceneryAssetManifestSchema,
  sceneryAssetTileEncoding,
  type SceneryAssetManifest,
  type SceneryAssetTileSummary,
} from '../../map/scenery.ts'

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

export type DroneWorldSceneryStatus =
  | {
      readonly status: 'available'
      readonly recipeId: string
      readonly tileTemplate: string
      readonly manifestUrl: string
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

export interface DroneSceneryTileAsset {
  readonly id: string
  readonly recipeId: string
  readonly z: number
  readonly x: number
  readonly y: number
  readonly url: string
  readonly center: DroneWorldCenter
  readonly localOrigin: DroneWorldPoint
  readonly distanceM: number
  readonly byteLength: number
  readonly featureCounts: SceneryAssetTileSummary['featureCounts']
}

export interface DroneWorldFeatureCount {
  readonly polygons: number
  readonly lines: number
  readonly points: number
}

export interface DroneWorldSceneryCoverage {
  readonly decoded: DroneWorldFeatureCount
  readonly selected: DroneWorldFeatureCount & {
    readonly buildings: number
    readonly roads: number
    readonly waterPolygons: number
    readonly waterways: number
    readonly vegetationPolygons: number
    readonly roadLabels: number
    readonly pois: number
  }
  readonly bytes: number
  readonly notes: ReadonlyArray<string>
}

export interface DroneMapWorldSnapshot {
  readonly key: string
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly zoom: number
  readonly scenerySource: 'asset-tiles'
  readonly tileCount: number
  readonly tiles: ReadonlyArray<DroneSceneryTileAsset>
  readonly coverage: DroneWorldSceneryCoverage
}

export interface DroneMapWorldCacheStats {
  readonly size: number
  readonly hits: number
  readonly misses: number
}

interface TileCoord {
  readonly x: number
  readonly y: number
  readonly z: number
}

const metersPerDegreeLat = 111_320
const maxWorldZoom = 14
const maxCachedWorldSnapshots = 8

let worldCacheHits = 0
let worldCacheMisses = 0

const cachedWorldSnapshots = new Map<string, Promise<DroneMapWorldSnapshot>>()

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

const horizontalDistanceFromCenterM = (
  point: DroneWorldPoint,
): number =>
  Math.hypot(point.x, point.z)

const lonToTileX = (lon: number, zoom: number): number =>
  Math.floor((lon + 180) / 360 * 2 ** zoom)

const latToTileY = (lat: number, zoom: number): number => {
  const latRad = lat * Math.PI / 180
  return Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * 2 ** zoom)
}

const tileRangeFor = (
  center: DroneWorldCenter,
  radiusM: number,
  zoom: number,
): ReadonlyArray<TileCoord> => {
  const lonDelta = radiusM / metersPerDegreeLonAt(center.lat)
  const latDelta = radiusM / metersPerDegreeLat
  const minX = lonToTileX(center.lon - lonDelta, zoom)
  const maxX = lonToTileX(center.lon + lonDelta, zoom)
  const minY = latToTileY(center.lat + latDelta, zoom)
  const maxY = latToTileY(center.lat - latDelta, zoom)
  const maxTile = 2 ** zoom - 1
  const tiles: TileCoord[] = []
  for (let x = Math.max(0, minX); x <= Math.min(maxTile, maxX); x += 1) {
    for (let y = Math.max(0, minY); y <= Math.min(maxTile, maxY); y += 1) {
      tiles.push({ x, y, z: zoom })
    }
  }
  return tiles
}

const tileKeyFor = (
  center: DroneWorldCenter,
  radiusM: number,
  zoom: number,
): string => {
  const tiles = tileRangeFor(center, radiusM, zoom)
  const first = tiles[0]
  const last = tiles[tiles.length - 1]
  return `${zoom}:${first?.x ?? 0}:${first?.y ?? 0}:${last?.x ?? 0}:${last?.y ?? 0}`
}

const tileCenterLonLat = (
  tile: TileCoord,
): DroneWorldCenter => {
  const size = 2 ** tile.z
  const lon = (tile.x + 0.5) / size * 360 - 180
  const n = Math.PI - 2 * Math.PI * (tile.y + 0.5) / size
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lon, lat }
}

const tileId = (tile: Pick<TileCoord, 'z' | 'x' | 'y'>): string =>
  `${tile.z}/${tile.x}/${tile.y}`

const cacheKeyFor = (config: {
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly zoom: number
}): string =>
  `${config.zoom}:${Math.round(config.radiusM)}:${config.center.lon.toFixed(6)}:${config.center.lat.toFixed(6)}`

const rememberCachedWorld = (
  key: string,
  promise: Promise<DroneMapWorldSnapshot>,
): void => {
  cachedWorldSnapshots.set(key, promise)
  while (cachedWorldSnapshots.size > maxCachedWorldSnapshots) {
    const oldestKey = cachedWorldSnapshots.keys().next().value
    if (typeof oldestKey !== 'string') break
    cachedWorldSnapshots.delete(oldestKey)
  }
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

const sceneryStatusFromManifest = (
  value: unknown,
): DroneWorldSceneryStatus => {
  const manifest = recordValue(value)
  const tilesets = Array.isArray(manifest?.tilesets) ? manifest.tilesets : null
  if (!tilesets) return { status: 'unknown', reason: 'map capability manifest has no tilesets array' }
  const scenery = tilesets
    .map(recordValue)
    .find(tileset => tileset?.kind === 'scenery')
  if (!scenery) return { status: 'unavailable', reason: 'scenery capability is not advertised' }

  const availability = recordValue(scenery.availability)
  const artifact = recordValue(scenery.artifact)
  const recipes = Array.isArray(scenery.recipes)
    ? scenery.recipes.map(recordValue).filter((recipe): recipe is Record<string, unknown> => recipe !== null)
    : []
  const recipe = recipes.find(candidate => candidate.detail === 'flight-visual') ?? recipes[0]
  const availabilityStatus = stringValue(availability?.status)
  const path = stringValue(availability?.path)
  if (availabilityStatus === 'available') {
    const recipeId = stringValue(recipe?.id)
    const tileTemplate = stringValue(artifact?.currentTileTemplate)
    const manifestUrl = stringValue(artifact?.manifestUrl)
    const tileEncoding = stringValue(artifact?.tileEncoding)
    const format = stringValue(artifact?.format)
    if (format !== 'directory-glb' || tileEncoding !== sceneryAssetTileEncoding || !recipeId || !tileTemplate || !manifestUrl) {
      return { status: 'unknown', reason: 'scenery capability is available but GLB artifact metadata is incomplete' }
    }
    return path
      ? { status: 'available', recipeId, tileTemplate, manifestUrl, path }
      : { status: 'available', recipeId, tileTemplate, manifestUrl }
  }

  if (availabilityStatus === 'unavailable') {
    const reason = stringValue(availability?.error) ?? 'precompiled scenery artifact is not present'
    return path
      ? { status: 'unavailable', reason, path }
      : { status: 'unavailable', reason }
  }

  return { status: 'unknown', reason: 'scenery capability has an invalid availability status' }
}

const loadMapCapabilityManifestBody = async (signal: AbortSignal | undefined): Promise<unknown> => {
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

export const loadDroneWorldSceneryStatus = async (config: {
  readonly signal?: AbortSignal
} = {}): Promise<DroneWorldSceneryStatus> => {
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

const loadSceneryManifest = async (config: {
  readonly status: Extract<DroneWorldSceneryStatus, { readonly status: 'available' }>
  readonly signal?: AbortSignal
}): Promise<SceneryAssetManifest> => {
  const response = await fetch(config.status.manifestUrl, config.signal ? { signal: config.signal } : undefined)
  if (!response.ok) throw new Error(`scenery manifest query failed with HTTP ${response.status}`)
  const parsed = sceneryAssetManifestSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error(`scenery manifest failed schema validation: ${parsed.error.message}`)
  return parsed.data
}

const sceneryUrlFor = (
  status: Extract<DroneWorldSceneryStatus, { readonly status: 'available' }>,
  tile: Pick<TileCoord, 'z' | 'x' | 'y'>,
): string =>
  status.tileTemplate
    .replace('{recipeId}', encodeURIComponent(status.recipeId))
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))

const summaryKey = (summary: Pick<SceneryAssetTileSummary, 'recipeId' | 'z' | 'x' | 'y'>): string =>
  `${summary.recipeId}:${summary.z}/${summary.x}/${summary.y}`

const coverageForTiles = (
  tiles: ReadonlyArray<DroneSceneryTileAsset>,
): DroneWorldSceneryCoverage => {
  const decoded = {
    polygons: tiles.reduce((sum, tile) => sum + tile.featureCounts.polygons, 0),
    lines: tiles.reduce((sum, tile) => sum + tile.featureCounts.lines, 0),
    points: tiles.reduce((sum, tile) => sum + tile.featureCounts.labels, 0),
  }
  const selected = {
    ...decoded,
    buildings: tiles.reduce((sum, tile) => sum + tile.featureCounts.buildings, 0),
    roads: tiles.reduce((sum, tile) => sum + tile.featureCounts.roads, 0),
    waterPolygons: tiles.reduce((sum, tile) => sum + tile.featureCounts.water, 0),
    waterways: 0,
    vegetationPolygons: tiles.reduce((sum, tile) => sum + tile.featureCounts.vegetation, 0),
    roadLabels: 0,
    pois: tiles.reduce((sum, tile) => sum + tile.featureCounts.labels, 0),
  }
  return {
    decoded,
    selected,
    bytes: tiles.reduce((sum, tile) => sum + tile.byteLength, 0),
    notes: tiles.length === 0 ? ['No precompiled scenery tiles intersect the requested flight world.'] : [],
  }
}

const assembleAssetTile = (config: {
  readonly summary: SceneryAssetTileSummary
  readonly status: Extract<DroneWorldSceneryStatus, { readonly status: 'available' }>
  readonly center: DroneWorldCenter
}): DroneSceneryTileAsset => {
  const tileCenter = {
    lon: config.summary.centerLon,
    lat: config.summary.centerLat,
  }
  const localOrigin = localPointFromLonLat(tileCenter.lon, tileCenter.lat, config.center)
  return {
    id: tileId(config.summary),
    recipeId: config.summary.recipeId,
    z: config.summary.z,
    x: config.summary.x,
    y: config.summary.y,
    url: sceneryUrlFor(config.status, config.summary),
    center: tileCenter,
    localOrigin,
    distanceM: horizontalDistanceFromCenterM(localOrigin),
    byteLength: config.summary.byteLength,
    featureCounts: config.summary.featureCounts,
  }
}

const loadAssetDroneMapWorld = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM: number
  readonly zoom: number
  readonly signal?: AbortSignal
  readonly scenery: Extract<DroneWorldSceneryStatus, { readonly status: 'available' }>
}): Promise<DroneMapWorldSnapshot> => {
  const manifest = await loadSceneryManifest({
    status: config.scenery,
    ...(config.signal === undefined ? {} : { signal: config.signal }),
  })
  const desiredTiles = tileRangeFor(config.center, config.radiusM, config.zoom)
  const available = new Map(manifest.tiles.map(summary => [summaryKey(summary), summary]))
  const tiles = desiredTiles
    .flatMap(tile => {
      const summary = available.get(summaryKey({ ...tile, recipeId: config.scenery.recipeId }))
      return summary ? [assembleAssetTile({ summary, status: config.scenery, center: config.center })] : []
    })
    .sort((left, right) => left.distanceM - right.distanceM || left.id.localeCompare(right.id))
  if (tiles.length === 0) {
    throw new Error(`precompiled scenery artifact has no tiles for ${config.center.lon.toFixed(5)},${config.center.lat.toFixed(5)} at z${config.zoom}`)
  }
  return {
    key: tileKeyFor(config.center, config.radiusM, config.zoom),
    center: config.center,
    radiusM: config.radiusM,
    zoom: config.zoom,
    scenerySource: 'asset-tiles',
    tileCount: tiles.length,
    tiles,
    coverage: coverageForTiles(tiles),
  }
}

export const loadDroneMapWorld = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM?: number
  readonly zoom?: number
  readonly signal?: AbortSignal
}): Promise<DroneMapWorldSnapshot> => {
  const radiusM = config.radiusM ?? 4_250
  const zoom = Math.min(maxWorldZoom, config.zoom ?? maxWorldZoom)
  const scenery = await loadDroneWorldSceneryStatus(config.signal === undefined ? {} : { signal: config.signal })
  if (scenery.status !== 'available') {
    throw new Error(`scenery capability unavailable: ${scenery.reason}`)
  }
  return await loadAssetDroneMapWorld({
    center: config.center,
    radiusM,
    zoom,
    ...(config.signal === undefined ? {} : { signal: config.signal }),
    scenery,
  })
}

export const loadCachedDroneMapWorld = async (config: {
  readonly center: DroneWorldCenter
  readonly radiusM?: number
  readonly zoom?: number
}): Promise<DroneMapWorldSnapshot> => {
  const radiusM = config.radiusM ?? 4_250
  const zoom = Math.min(maxWorldZoom, config.zoom ?? maxWorldZoom)
  const key = cacheKeyFor({ center: config.center, radiusM, zoom })
  const existing = cachedWorldSnapshots.get(key)
  if (existing) {
    worldCacheHits += 1
    return existing
  }
  worldCacheMisses += 1
  const promise = loadDroneMapWorld({ center: config.center, radiusM, zoom })
  rememberCachedWorld(key, promise)
  try {
    return await promise
  } catch (err) {
    cachedWorldSnapshots.delete(key)
    throw err
  }
}

export const droneMapWorldCacheStats = (): DroneMapWorldCacheStats => ({
  size: cachedWorldSnapshots.size,
  hits: worldCacheHits,
  misses: worldCacheMisses,
})
