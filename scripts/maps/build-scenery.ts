import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { PMTiles, TileType, type Source } from 'pmtiles'
import { defaultSceneryRecipes, mapTilesetId } from '../../src/map/capabilities.ts'
import { compileSceneryTileFromVectorTile } from '../../src/map/scenery-compiler.ts'
import { compileSceneryGlbTile } from '../../src/map/scenery-glb.ts'
import { buildSceneryTilesetDocument } from '../../src/map/scenery-tileset.ts'
import {
  sceneryAssetTilesetSchema,
  sceneryTileHasFeatures,
  type SceneryAssetLodLevel,
  type SceneryAssetTileSummary,
  type SceneryTileCoord,
} from '../../src/map/scenery.ts'
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

const expandedBoundsForPoints = (
  points: ReadonlyArray<readonly [number, number]>,
  radiusM: number,
): Bounds => {
  if (points.length === 0) throw new Error('cannot derive scenery bounds from an empty point set')
  const minLon = Math.min(...points.map(point => point[0]))
  const maxLon = Math.max(...points.map(point => point[0]))
  const minLat = Math.min(...points.map(point => point[1]))
  const maxLat = Math.max(...points.map(point => point[1]))
  const centerLat = (minLat + maxLat) / 2
  const lonDelta = radiusM / metersPerDegreeLonAt(centerLat)
  const latDelta = radiusM / metersPerDegreeLat
  return {
    minLon: minLon - lonDelta,
    minLat: minLat - latDelta,
    maxLon: maxLon + lonDelta,
    maxLat: maxLat + latDelta,
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

const positiveNumberEnv = (key: string, defaultValue: number): number => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return defaultValue
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number`)
  return value
}

const parseZooms = (config: { readonly minZoom: number; readonly maxZoom: number }): ReadonlyArray<number> => {
  const defaultZooms = Array.from({ length: config.maxZoom - config.minZoom + 1 }, (_value, index) => config.minZoom + index)
  const raw = process.env.LEITBILD_SCENERY_ZOOMS ?? defaultZooms.join(',')
  const zooms = raw.split(',').map(part => {
    const value = Number(part.trim())
    if (!Number.isInteger(value) || value < 0 || value > 24) throw new Error('LEITBILD_SCENERY_ZOOMS must contain comma-separated integer zooms from 0 to 24')
    return value
  })
  return [...new Set(zooms)].sort((left, right) => left - right)
}

const lodLevelsFor = (
  summaries: ReadonlyArray<SceneryAssetTileSummary>,
): ReadonlyArray<SceneryAssetLodLevel> => {
  const byZoom = new Map<number, SceneryAssetLodLevel>()
  for (const summary of summaries) {
    const existing = byZoom.get(summary.lod.zoom)
    if (!existing || summary.lod.geometricErrorM > existing.geometricErrorM) {
      byZoom.set(summary.lod.zoom, summary.lod)
    }
  }
  return [...byZoom.values()].sort((left, right) => left.zoom - right.zoom)
}

const tuplePosition = (value: unknown): readonly [number, number] | null => {
  if (!Array.isArray(value) || value.length < 2) return null
  const lon = value[0]
  const lat = value[1]
  return typeof lon === 'number' && Number.isFinite(lon) && typeof lat === 'number' && Number.isFinite(lat)
    ? [lon, lat]
    : null
}

const scenarioPositionsFromValue = (value: unknown): ReadonlyArray<readonly [number, number]> => {
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const positions: Array<readonly [number, number]> = []
  const mapCenter = tuplePosition((record.world as Record<string, unknown> | undefined)?.mapCenter)
  if (mapCenter) positions.push(mapCenter)
  const surfaceRegions = Array.isArray((record.surface as Record<string, unknown> | undefined)?.regions)
    ? (record.surface as { readonly regions: ReadonlyArray<unknown> }).regions
    : []
  for (const region of surfaceRegions) {
    if (region === null || typeof region !== 'object') continue
    const config = (region as Record<string, unknown>).config
    if (config === null || typeof config !== 'object') continue
    const center = tuplePosition((config as Record<string, unknown>).center)
    if (center) positions.push(center)
  }
  const objects = Array.isArray(record.objects) ? record.objects : []
  for (const object of objects) {
    if (object === null || typeof object !== 'object') continue
    const position = tuplePosition((object as Record<string, unknown>).position)
    if (position) positions.push(position)
  }
  return positions
}

const scenarioMatchesRecipe = (
  value: unknown,
  recipe: typeof defaultSceneryRecipes[number],
): boolean => {
  const packIds = recipe.scenarioPackIds
  if (!packIds || packIds.length === 0) return true
  if (value === null || typeof value !== 'object') return false
  const packs = (value as Record<string, unknown>).packs
  if (!Array.isArray(packs)) return false
  return packs.some(pack => typeof pack === 'string' && packIds.includes(pack))
}

const scenarioPathsFromEnv = async (): Promise<{
  readonly paths: ReadonlyArray<string>
  readonly explicit: boolean
}> => {
  const raw = process.env.LEITBILD_SCENERY_SCENARIOS
  if (raw && raw.trim().length > 0) {
    return {
      explicit: true,
      paths: raw.split(',').map(part => resolve(part.trim())).filter(path => path.length > 0),
    }
  }
  const scenarioDir = resolve('src', 'scenarios')
  const entries = await readdir(scenarioDir, { withFileTypes: true })
  return {
    explicit: false,
    paths: entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.scenario.json'))
      .map(entry => join(scenarioDir, entry.name)),
  }
}

const boundsFromScenarioConfigs = async (
  recipe: typeof defaultSceneryRecipes[number],
): Promise<Bounds> => {
  const discovery = await scenarioPathsFromEnv()
  const points: Array<readonly [number, number]> = []
  let matchedScenarioCount = 0
  for (const path of discovery.paths) {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!discovery.explicit && !scenarioMatchesRecipe(parsed, recipe)) continue
    matchedScenarioCount += 1
    points.push(...scenarioPositionsFromValue(parsed))
  }
  if (points.length === 0) {
    const recipeContext = recipe.scenarioPackIds && recipe.scenarioPackIds.length > 0
      ? ` for recipe ${recipe.id} packs ${recipe.scenarioPackIds.join(',')}`
      : ''
    throw new Error(`No scenario positions were found${recipeContext}; set LEITBILD_SCENERY_BOUNDS, center/radius, LEITBILD_SCENERY_SCENARIOS, or LEITBILD_SCENERY_ALLOW_FULL_BOUNDS=1`)
  }
  if (matchedScenarioCount === 0) throw new Error(`No scenario configs matched scenery recipe ${recipe.id}`)
  return expandedBoundsForPoints(points, positiveNumberEnv('LEITBILD_SCENERY_SCENARIO_RADIUS_M', 8_000))
}

const parseBounds = async (
  headerBounds: Bounds,
  recipe: typeof defaultSceneryRecipes[number],
): Promise<Bounds> => {
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
  return await boundsFromScenarioConfigs(recipe)
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
const zooms = parseZooms({ minZoom: recipe.minZoom, maxZoom: recipe.maxZoom })
for (const zoom of zooms) {
  if (zoom < header.minZoom || zoom > header.maxZoom) throw new Error(`zoom ${zoom} is outside source PMTiles zoom range ${header.minZoom}-${header.maxZoom}`)
}

const bounds = await parseBounds({
  minLon: header.minLon,
  minLat: header.minLat,
  maxLon: header.maxLon,
  maxLat: header.maxLat,
}, recipe)
await rm(join(outputRoot, recipe.id), { recursive: true, force: true })
await rm(join(outputRoot, 'tileset.json'), { force: true })
let decodedTileCount = 0
let emptyTileCount = 0
let writtenTileCount = 0
let polygonCount = 0
let lineCount = 0
let labelCount = 0
let buildingCount = 0
let roadCount = 0
let waterCount = 0
let vegetationCount = 0
let byteCount = 0
const tileSummaries: SceneryAssetTileSummary[] = []

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
    const glb = compileSceneryGlbTile(scenery)
    if (!glb) {
      emptyTileCount += 1
      return
    }
    const tilePath = join(outputRoot, recipe.id, String(tile.z), String(tile.x), `${tile.y}.glb`)
    await mkdir(dirname(tilePath), { recursive: true })
    await Bun.write(tilePath, glb.bytes)
    writtenTileCount += 1
    polygonCount += scenery.features.polygons.length
    lineCount += scenery.features.lines.length
    labelCount += scenery.features.labels.length
    buildingCount += glb.summary.featureCounts.buildings
    roadCount += glb.summary.featureCounts.roads
    waterCount += glb.summary.featureCounts.water
    vegetationCount += glb.summary.featureCounts.vegetation
    byteCount += glb.bytes.byteLength
    tileSummaries.push({
      ...glb.summary,
      byteLength: glb.bytes.byteLength,
    })
  })
}

if (writtenTileCount === 0) {
  throw new Error(`scenery build produced no GLB tiles for ${recipe.id}; check selected bounds ${JSON.stringify(bounds)} and source PMTiles coverage`)
}

await mkdir(outputRoot, { recursive: true })
const builtAt = new Date().toISOString()
const counts = {
  decodedTileCount,
  emptyTileCount,
  writtenTileCount,
  polygons: polygonCount,
  lines: lineCount,
  labels: labelCount,
  buildings: buildingCount,
  roads: roadCount,
  water: waterCount,
  vegetation: vegetationCount,
  bytes: byteCount,
}
const tiles = tileSummaries.sort((left, right) => left.z - right.z || left.x - right.x || left.y - right.y)
const tileset = buildSceneryTilesetDocument({
  tilesetId: 'leitbild-scenery-norway',
  sourceTilesetId: mapTilesetId,
  sourcePmtilesPath: pmtilesPath,
  builtAt,
  bounds,
  zooms,
  lodLevels: lodLevelsFor(tiles),
  inputArtifacts: [{
    kind: 'base-vector-pmtiles' as const,
    id: mapTilesetId,
    path: pmtilesPath,
    required: true,
  }],
  recipes: [recipe],
  outputRoot,
  counts,
  tiles,
})
const parsedTileset = sceneryAssetTilesetSchema.parse(tileset)
await Bun.write(join(outputRoot, 'tileset.json'), `${JSON.stringify(parsedTileset, null, 2)}\n`)
console.log(JSON.stringify({
  schemaVersion: parsedTileset.extras.leitbild.schemaVersion,
  artifactFormat: parsedTileset.extras.leitbild.artifactFormat,
  tileEncoding: parsedTileset.extras.leitbild.tileEncoding,
  tilesetId: parsedTileset.extras.leitbild.tilesetId,
  sourceTilesetId: parsedTileset.extras.leitbild.sourceTilesetId,
  sourcePmtilesPath: parsedTileset.extras.leitbild.sourcePmtilesPath,
  builtAt: parsedTileset.extras.leitbild.builtAt,
  bounds: parsedTileset.extras.leitbild.bounds,
  origin: parsedTileset.extras.leitbild.origin,
  zooms: parsedTileset.extras.leitbild.zooms,
  lodLevels: parsedTileset.extras.leitbild.lodLevels,
  inputArtifacts: parsedTileset.extras.leitbild.inputArtifacts,
  outputRoot: parsedTileset.extras.leitbild.outputRoot,
  counts: parsedTileset.extras.leitbild.counts,
  geometricError: parsedTileset.geometricError,
}, null, 2))
