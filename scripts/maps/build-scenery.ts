import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { PMTiles, TileType, type Source } from 'pmtiles'
import { defaultSceneryRecipes, mapTilesetId } from '../../src/map/capabilities.ts'
import { compileSceneryTileFromVectorTile } from '../../src/map/scenery-compiler.ts'
import { sceneryTileHasFeatures, type SceneryTileCoord } from '../../src/map/scenery.ts'
import { createMapPipelineConfig } from './config.ts'

interface Bounds {
  readonly minLon: number
  readonly minLat: number
  readonly maxLon: number
  readonly maxLat: number
}

const metersPerDegreeLat = 111_320

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

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const lonToTileX = (lon: number, zoom: number): number =>
  Math.floor((lon + 180) / 360 * 2 ** zoom)

const latToTileY = (lat: number, zoom: number): number => {
  const latRad = lat * Math.PI / 180
  return Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * 2 ** zoom)
}

const boundsFromCenterRadius = (config: {
  readonly lon: number
  readonly lat: number
  readonly radiusM: number
}): Bounds => {
  const lonDelta = config.radiusM / metersPerDegreeLonAt(config.lat)
  const latDelta = config.radiusM / metersPerDegreeLat
  return {
    minLon: config.lon - lonDelta,
    minLat: config.lat - latDelta,
    maxLon: config.lon + lonDelta,
    maxLat: config.lat + latDelta,
  }
}

const tileRangeForBounds = (
  bounds: Bounds,
  zoom: number,
): ReadonlyArray<SceneryTileCoord> => {
  const minX = lonToTileX(bounds.minLon, zoom)
  const maxX = lonToTileX(bounds.maxLon, zoom)
  const minY = latToTileY(bounds.maxLat, zoom)
  const maxY = latToTileY(bounds.minLat, zoom)
  const maxTile = 2 ** zoom - 1
  const tiles: SceneryTileCoord[] = []
  for (let x = Math.max(0, minX); x <= Math.min(maxTile, maxX); x += 1) {
    for (let y = Math.max(0, minY); y <= Math.min(maxTile, maxY); y += 1) {
      tiles.push({ z: zoom, x, y })
    }
  }
  return tiles
}

const finiteNumberEnv = (key: string): number | null => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
  return value
}

const positiveIntegerEnv = (key: string, defaultValue: number): number => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`)
  return value
}

const parseZooms = (): ReadonlyArray<number> => {
  const raw = process.env.LEITBILD_SCENERY_ZOOMS ?? '14'
  const zooms = raw.split(',').map(part => {
    const value = Number(part.trim())
    if (!Number.isInteger(value) || value < 0 || value > 24) throw new Error('LEITBILD_SCENERY_ZOOMS must contain comma-separated integer zooms from 0 to 24')
    return value
  })
  return [...new Set(zooms)].sort((left, right) => left - right)
}

const parseBounds = (headerBounds: Bounds): Bounds => {
  const rawBounds = process.env.LEITBILD_SCENERY_BOUNDS
  if (rawBounds) {
    const parts = rawBounds.split(',').map(part => Number(part.trim()))
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
      throw new Error('LEITBILD_SCENERY_BOUNDS must be minLon,minLat,maxLon,maxLat')
    }
    const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number]
    if (minLon >= maxLon || minLat >= maxLat) throw new Error('LEITBILD_SCENERY_BOUNDS has invalid ordering')
    return { minLon, minLat, maxLon, maxLat }
  }

  const centerLon = finiteNumberEnv('LEITBILD_SCENERY_CENTER_LON')
  const centerLat = finiteNumberEnv('LEITBILD_SCENERY_CENTER_LAT')
  const radiusM = finiteNumberEnv('LEITBILD_SCENERY_RADIUS_M')
  if (centerLon !== null || centerLat !== null || radiusM !== null) {
    if (centerLon === null || centerLat === null || radiusM === null || radiusM <= 0) {
      throw new Error('LEITBILD_SCENERY_CENTER_LON, LEITBILD_SCENERY_CENTER_LAT, and positive LEITBILD_SCENERY_RADIUS_M must be supplied together')
    }
    return boundsFromCenterRadius({ lon: centerLon, lat: centerLat, radiusM })
  }

  if (process.env.LEITBILD_SCENERY_ALLOW_FULL_BOUNDS === '1') return headerBounds
  throw new Error('Set LEITBILD_SCENERY_BOUNDS, set center/radius env vars, or set LEITBILD_SCENERY_ALLOW_FULL_BOUNDS=1 for a full source-bounds build')
}

const mapWithConcurrency = async <Input, Output>(
  items: ReadonlyArray<Input>,
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<ReadonlyArray<Output>> => {
  const results: Output[] = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index]!, index)
    }
  }
  const workers: Promise<void>[] = []
  for (let index = 0; index < workerCount; index += 1) workers.push(runWorker())
  await Promise.all(workers)
  return results
}

const config = createMapPipelineConfig()
const pmtilesPath = resolve(process.env.LEITBILD_SCENERY_SOURCE_PMTILES ?? join(config.rootDir, 'current', 'norway.pmtiles'))
const recipeId = process.env.LEITBILD_SCENERY_RECIPE_ID ?? 'drone-urban-flight'
const recipe = defaultSceneryRecipes.find(candidate => candidate.id === recipeId)
if (!recipe) throw new Error(`unknown scenery recipe: ${recipeId}`)
const outputRoot = resolve(process.env.LEITBILD_SCENERY_OUTPUT_ROOT ?? join(config.rootDir, 'current', 'scenery'))
const concurrency = positiveIntegerEnv('LEITBILD_SCENERY_BUILD_CONCURRENCY', 16)

const file = Bun.file(pmtilesPath)
if (!await file.exists()) throw new Error(`source PMTiles artifact does not exist: ${pmtilesPath}`)
const archive = new PMTiles(createBunFileSource(pmtilesPath, pmtilesPath))
const header = await archive.getHeader()
if (header.tileType !== TileType.Mvt) throw new Error(`scenery build requires an MVT PMTiles archive; found tileType ${header.tileType}`)
const zooms = parseZooms()
for (const zoom of zooms) {
  if (zoom < header.minZoom || zoom > header.maxZoom) throw new Error(`zoom ${zoom} is outside source PMTiles zoom range ${header.minZoom}-${header.maxZoom}`)
}

const bounds = parseBounds({
  minLon: header.minLon,
  minLat: header.minLat,
  maxLon: header.maxLon,
  maxLat: header.maxLat,
})
let decodedTileCount = 0
let emptyTileCount = 0
let writtenTileCount = 0
let polygonCount = 0
let lineCount = 0
let labelCount = 0

for (const zoom of zooms) {
  const tiles = tileRangeForBounds(bounds, zoom)
  await mapWithConcurrency(tiles, concurrency, async tile => {
    const source = await archive.getZxy(tile.z, tile.x, tile.y)
    if (!source) {
      emptyTileCount += 1
      return
    }
    decodedTileCount += 1
    const pbf = new PbfReader(new Uint8Array(source.data)) as unknown as ConstructorParameters<typeof VectorTile>[0]
    const scenery = compileSceneryTileFromVectorTile({
      vectorTile: new VectorTile(pbf),
      tile,
      recipe,
    })
    if (!sceneryTileHasFeatures(scenery)) {
      emptyTileCount += 1
      return
    }
    const tilePath = join(outputRoot, recipe.id, String(tile.z), String(tile.x), `${tile.y}.json`)
    await mkdir(dirname(tilePath), { recursive: true })
    await Bun.write(tilePath, `${JSON.stringify(scenery)}\n`)
    writtenTileCount += 1
    polygonCount += scenery.features.polygons.length
    lineCount += scenery.features.lines.length
    labelCount += scenery.features.labels.length
  })
}

await mkdir(outputRoot, { recursive: true })
const manifest = {
  schemaVersion: 1,
  tilesetId: 'leitbild-scenery-norway',
  sourceTilesetId: mapTilesetId,
  sourcePmtilesPath: pmtilesPath,
  builtAt: new Date().toISOString(),
  bounds,
  zooms,
  recipes: [recipe],
  outputRoot,
  counts: {
    decodedTileCount,
    emptyTileCount,
    writtenTileCount,
    polygons: polygonCount,
    lines: lineCount,
    labels: labelCount,
  },
}
await Bun.write(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify(manifest, null, 2))
