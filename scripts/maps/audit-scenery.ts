import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { join } from 'node:path'
import { PMTiles, TileType, type Source } from 'pmtiles'
import { createMapPipelineConfig } from './config.ts'

interface TileCoord {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface LayerAudit {
  featureCount: number
  namedFeatureCount: number
  geometryCounts: Record<string, number>
  classCounts: Record<string, number>
}

const auditedLayers = [
  'landcover',
  'landuse',
  'water',
  'waterway',
  'building',
  'transportation',
  'transportation_name',
  'poi',
  'aeroway',
  'boundary',
  'place',
] as const

const metersPerDegreeLat = 111_320

const requiredNumberEnv = (key: string): number => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') throw new Error(`${key} is required`)
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
  return value
}

const optionalPositiveNumberEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number`)
  return value
}

const optionalIntegerEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 24) throw new Error(`${key} must be an integer from 0 to 24`)
  return value
}

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const lonToTileX = (lon: number, zoom: number): number =>
  Math.floor((lon + 180) / 360 * 2 ** zoom)

const latToTileY = (lat: number, zoom: number): number => {
  const latRad = lat * Math.PI / 180
  return Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * 2 ** zoom)
}

const tileRangeFor = (
  center: { readonly lon: number; readonly lat: number },
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

const createBunFileSource = (filePath: string, key: string): Source => ({
  getKey: (): string => key,
  getBytes: async (
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<{ readonly data: ArrayBuffer }> => {
    signal?.throwIfAborted()
    const data = await Bun.file(filePath).slice(offset, offset + length).arrayBuffer()
    signal?.throwIfAborted()
    return { data }
  },
})

const geometryNameFor = (type: number): string => {
  if (type === 1) return 'point'
  if (type === 2) return 'line'
  if (type === 3) return 'polygon'
  return `unknown:${type}`
}

const increment = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1
}

const createLayerAudit = (): LayerAudit => ({
  featureCount: 0,
  namedFeatureCount: 0,
  geometryCounts: {},
  classCounts: {},
})

const sortedCounts = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])))

const summarizeLayerAudit = (audit: LayerAudit): LayerAudit => ({
  featureCount: audit.featureCount,
  namedFeatureCount: audit.namedFeatureCount,
  geometryCounts: sortedCounts(audit.geometryCounts),
  classCounts: sortedCounts(audit.classCounts),
})

const noteFor = (
  layerAudits: ReadonlyMap<string, LayerAudit>,
): ReadonlyArray<string> => {
  const notes: string[] = []
  const buildings = layerAudits.get('building')?.featureCount ?? 0
  const roads = layerAudits.get('transportation')?.featureCount ?? 0
  const landcover = layerAudits.get('landcover')?.featureCount ?? 0
  const water = layerAudits.get('water')?.featureCount ?? 0
  if (buildings === 0) notes.push('No building features were found in the sampled vector tiles; 3D building density is source-data limited here.')
  if (roads === 0) notes.push('No transportation features were found in the sampled vector tiles; road rendering is source-data limited here.')
  if (landcover === 0) notes.push('No landcover features were found in the sampled vector tiles; vegetation/non-city variation may be sparse.')
  if (water === 0) notes.push('No water polygons were found in the sampled vector tiles; waterways may still be present as lines.')
  return notes
}

const config = createMapPipelineConfig()
const center = {
  lon: requiredNumberEnv('LEITBILD_SCENERY_AUDIT_LON'),
  lat: requiredNumberEnv('LEITBILD_SCENERY_AUDIT_LAT'),
}
const radiusM = optionalPositiveNumberEnv('LEITBILD_SCENERY_AUDIT_RADIUS_M', 1_750)
const zoom = optionalIntegerEnv('LEITBILD_SCENERY_AUDIT_ZOOM', 14)
const pmtilesPath = process.env.LEITBILD_SCENERY_AUDIT_PMTILES_PATH ?? join(config.rootDir, 'current', 'norway.pmtiles')
const file = Bun.file(pmtilesPath)
if (!await file.exists()) throw new Error(`PMTiles artifact does not exist: ${pmtilesPath}`)

const archive = new PMTiles(createBunFileSource(pmtilesPath, pmtilesPath))
const header = await archive.getHeader()
if (header.tileType !== TileType.Mvt) throw new Error(`scenery audit requires an MVT PMTiles archive; found tileType ${header.tileType}`)
if (zoom < header.minZoom || zoom > header.maxZoom) throw new Error(`zoom ${zoom} is outside PMTiles zoom range ${header.minZoom}-${header.maxZoom}`)

const tiles = tileRangeFor(center, radiusM, zoom)
const layerAudits = new Map<string, LayerAudit>(auditedLayers.map(layer => [layer, createLayerAudit()]))
let decodedTileCount = 0
let emptyTileCount = 0
for (const tileCoord of tiles) {
  const tile = await archive.getZxy(tileCoord.z, tileCoord.x, tileCoord.y)
  if (!tile) {
    emptyTileCount += 1
    continue
  }
  decodedTileCount += 1
  const vectorTile = new VectorTile(new PbfReader(new Uint8Array(tile.data)) as unknown as ConstructorParameters<typeof VectorTile>[0])
  for (const layerId of auditedLayers) {
    const layer = vectorTile.layers[layerId]
    if (!layer) continue
    const audit = layerAudits.get(layerId)
    if (!audit) continue
    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index)
      audit.featureCount += 1
      increment(audit.geometryCounts, geometryNameFor(feature.type))
      const properties = feature.properties as Record<string, unknown>
      const className = typeof properties.class === 'string' && properties.class.length > 0
        ? properties.class
        : typeof properties.type === 'string' && properties.type.length > 0
          ? properties.type
          : 'unclassified'
      increment(audit.classCounts, className)
      if (typeof properties.name === 'string' && properties.name.length > 0) audit.namedFeatureCount += 1
    }
  }
}

console.log(JSON.stringify({
  pmtilesPath,
  center,
  radiusM,
  zoom,
  tileCount: tiles.length,
  decodedTileCount,
  emptyTileCount,
  header: {
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
  },
  layers: Object.fromEntries([...layerAudits.entries()].map(([layer, audit]) => [layer, summarizeLayerAudit(audit)])),
  notes: noteFor(layerAudits),
}, null, 2))
