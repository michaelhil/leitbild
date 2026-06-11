import { copyFile, link, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { TileType } from 'pmtiles'
import { terrainTilesetId } from '../../src/map/capabilities.ts'
import { writePmtilesArchive, type PmtilesWriterBounds, type PmtilesWriterTile } from '../../src/map/pmtiles-writer.ts'
import { readTerrainPmtilesMetadata } from '../../src/map/terrain-artifact.ts'
import { createMapPipelineConfig } from './config.ts'

interface TileCoord {
  readonly z: number
  readonly x: number
  readonly y: number
}

const defaultTerrainSourceTemplate = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const defaultOsloBounds: PmtilesWriterBounds = {
  minLon: 10.55,
  minLat: 59.78,
  maxLon: 10.95,
  maxLat: 60.05,
}

const lonToTileX = (lon: number, zoom: number): number =>
  Math.floor(((lon + 180) / 360) * 2 ** zoom)

const latToTileY = (lat: number, zoom: number): number => {
  const latRad = lat * Math.PI / 180
  return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * 2 ** zoom)
}

const tileRangeForBounds = (
  bounds: PmtilesWriterBounds,
  zoom: number,
): ReadonlyArray<TileCoord> => {
  const minX = lonToTileX(bounds.minLon, zoom)
  const maxX = lonToTileX(bounds.maxLon, zoom)
  const minY = latToTileY(bounds.maxLat, zoom)
  const maxY = latToTileY(bounds.minLat, zoom)
  const tiles: TileCoord[] = []
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      tiles.push({ z: zoom, x, y })
    }
  }
  return tiles
}

const positiveIntegerEnv = (key: string, defaultValue: number): number => {
  const raw = process.env[key]
  if (!raw) return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`)
  return value
}

const boundsFromEnv = (): PmtilesWriterBounds | null => {
  const raw = process.env.LEITBILD_TERRAIN_BOUNDS
  if (!raw) return null
  const parts = raw.split(',').map(part => Number(part.trim()))
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
    throw new Error('LEITBILD_TERRAIN_BOUNDS must be minLon,minLat,maxLon,maxLat')
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number]
  if (minLon >= maxLon || minLat >= maxLat) throw new Error('LEITBILD_TERRAIN_BOUNDS has invalid ordering')
  return { minLon, minLat, maxLon, maxLat }
}

const expandedBounds = (
  bounds: PmtilesWriterBounds,
  paddingDegrees: number,
): PmtilesWriterBounds => ({
  minLon: bounds.minLon - paddingDegrees,
  minLat: bounds.minLat - paddingDegrees,
  maxLon: bounds.maxLon + paddingDegrees,
  maxLat: bounds.maxLat + paddingDegrees,
})

const boundsFromCurrentScenery = async (mapRoot: string): Promise<PmtilesWriterBounds | null> => {
  const path = join(mapRoot, 'current', 'scenery', 'tileset.json')
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      readonly extras?: {
        readonly leitbild?: {
          readonly bounds?: Partial<PmtilesWriterBounds>
        }
      }
    }
    const bounds = parsed.extras?.leitbild?.bounds
    if (
      bounds
      && Number.isFinite(bounds.minLon)
      && Number.isFinite(bounds.minLat)
      && Number.isFinite(bounds.maxLon)
      && Number.isFinite(bounds.maxLat)
      && Number(bounds.minLon) < Number(bounds.maxLon)
      && Number(bounds.minLat) < Number(bounds.maxLat)
    ) {
      return {
        minLon: Number(bounds.minLon),
        minLat: Number(bounds.minLat),
        maxLon: Number(bounds.maxLon),
        maxLat: Number(bounds.maxLat),
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`terrain bootstrap could not derive bounds from current scenery; using fallback bounds if no explicit bounds are set. ${reason}`)
    return null
  }
  return null
}

const tileUrl = (
  template: string,
  coord: TileCoord,
): string =>
  template
    .replace('{z}', String(coord.z))
    .replace('{x}', String(coord.x))
    .replace('{y}', String(coord.y))

const fetchTile = async (
  template: string,
  coord: TileCoord,
): Promise<PmtilesWriterTile> => {
  const url = tileUrl(template, coord)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to fetch terrain tile ${coord.z}/${coord.x}/${coord.y}: HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('image/png')) throw new Error(`terrain tile ${coord.z}/${coord.x}/${coord.y} is not PNG: ${contentType}`)
  return {
    ...coord,
    data: new Uint8Array(await response.arrayBuffer()),
  }
}

const mapWithConcurrency = async <Input, Output>(
  items: ReadonlyArray<Input>,
  concurrency: number,
  worker: (item: Input) => Promise<Output>,
): Promise<ReadonlyArray<Output>> => {
  const results = new Array<Output>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await worker(item)
    }
  })
  await Promise.all(workers)
  return results
}

const hardlinkOrCopy = async (sourcePath: string, targetPath: string): Promise<'hardlink' | 'copy'> => {
  await rm(targetPath, { force: true })
  try {
    await link(sourcePath, targetPath)
    return 'hardlink'
  } catch {
    await copyFile(sourcePath, targetPath)
    return 'copy'
  }
}

const readJsonObject = async (filePath: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  throw new Error(`${filePath} does not contain a JSON object`)
}

const promoteRelease = async (
  releaseDir: string,
  mapRoot: string,
): Promise<void> => {
  const currentPath = join(mapRoot, 'current')
  const nextPath = join(mapRoot, 'current.next')
  await rm(nextPath, { recursive: true, force: true })
  await symlink(releaseDir, nextPath)
  await rm(currentPath, { recursive: true, force: true })
  await rename(nextPath, currentPath)
}

const config = createMapPipelineConfig()
const sourceTemplate = process.env.LEITBILD_TERRAIN_SOURCE_TEMPLATE ?? defaultTerrainSourceTemplate
const zoom = positiveIntegerEnv('LEITBILD_TERRAIN_BOOTSTRAP_ZOOM', 13)
const concurrency = positiveIntegerEnv('LEITBILD_TERRAIN_BOOTSTRAP_CONCURRENCY', 12)
const maxTiles = positiveIntegerEnv('LEITBILD_TERRAIN_BOOTSTRAP_MAX_TILES', 800)
const rawPaddingDegrees = Number(process.env.LEITBILD_TERRAIN_BOOTSTRAP_PADDING_DEGREES ?? 0.08)
if (!Number.isFinite(rawPaddingDegrees) || rawPaddingDegrees < 0) {
  throw new Error('LEITBILD_TERRAIN_BOOTSTRAP_PADDING_DEGREES must be a nonnegative number')
}
const sceneryBounds = await boundsFromCurrentScenery(config.rootDir)
const sourceBounds = boundsFromEnv() ?? sceneryBounds ?? defaultOsloBounds
const bounds = expandedBounds(sourceBounds, rawPaddingDegrees)
const tiles = tileRangeForBounds(bounds, zoom)
if (tiles.length > maxTiles) {
  throw new Error(`terrain bootstrap selected ${tiles.length} tiles, above LEITBILD_TERRAIN_BOOTSTRAP_MAX_TILES=${maxTiles}`)
}

const currentDir = await realpath(join(config.rootDir, 'current'))
const targetReleaseDir = resolve(config.releaseDir)
if (targetReleaseDir === currentDir) {
  throw new Error('refusing to bootstrap terrain directly into the active current release; set LEITBILD_MAP_BUILD_ID or LEITBILD_MAP_RELEASE_DIR')
}

await mkdir(config.buildDir, { recursive: true })
const terrainTiles = await mapWithConcurrency(tiles, concurrency, tile => fetchTile(sourceTemplate, tile))
const terrainBytes = writePmtilesArchive({
  tiles: terrainTiles,
  tileType: TileType.Png,
  bounds,
  center: {
    lon: (bounds.minLon + bounds.maxLon) / 2,
    lat: (bounds.minLat + bounds.maxLat) / 2,
    zoom,
  },
  metadata: {
    id: terrainTilesetId,
    sourceTemplate,
    demEncoding: 'terrarium',
    bounds,
    zoom,
  },
})
const terrainBuildPath = join(config.buildDir, 'terrain.pmtiles')
await Bun.write(terrainBuildPath, terrainBytes)

await mkdir(targetReleaseDir, { recursive: true })
const clonedFiles = ['norway.pmtiles', 'style.json', 'capabilities.json'] as const
const cloneModes: Record<string, 'hardlink' | 'copy'> = {}
for (const fileName of clonedFiles) {
  const sourceFile = join(currentDir, fileName)
  await stat(sourceFile)
  cloneModes[fileName] = await hardlinkOrCopy(sourceFile, join(targetReleaseDir, fileName))
}

const currentBuild = await readJsonObject(join(currentDir, 'build.json'))
const terrainTargetPath = join(targetReleaseDir, 'terrain.pmtiles')
await copyFile(terrainBuildPath, `${terrainTargetPath}.tmp`)
await rename(`${terrainTargetPath}.tmp`, terrainTargetPath)
const terrainMetadata = await readTerrainPmtilesMetadata({
  filePath: terrainTargetPath,
  demEncoding: 'terrarium',
})

await writeFile(join(targetReleaseDir, 'terrain.json'), `${JSON.stringify({
  ingestedAt: new Date().toISOString(),
  sourcePath: sourceTemplate,
  sourceFileName: basename(sourceTemplate),
  source: {
    demEncoding: 'terrarium',
    zoom,
    bounds,
    tileCount: terrainTiles.length,
  },
  artifact: terrainMetadata,
}, null, 2)}\n`)

await writeFile(join(targetReleaseDir, 'build.json'), `${JSON.stringify({
  ...currentBuild,
  buildId: config.buildId,
  builtAt: new Date().toISOString(),
  basedOnReleaseDir: currentDir,
  terrain: {
    sourcePath: sourceTemplate,
    demEncoding: 'terrarium',
    artifactPath: terrainTargetPath,
    minZoom: terrainMetadata.minZoom,
    maxZoom: terrainMetadata.maxZoom,
    bounds: terrainMetadata.bounds,
  },
  clonedFiles: cloneModes,
}, null, 2)}\n`)

if (process.env.LEITBILD_TERRAIN_BOOTSTRAP_PROMOTE === '1') {
  await promoteRelease(targetReleaseDir, config.rootDir)
}

console.log(JSON.stringify({
  releaseDir: targetReleaseDir,
  currentDir,
  promoted: process.env.LEITBILD_TERRAIN_BOOTSTRAP_PROMOTE === '1',
  terrain: terrainMetadata,
  tileCount: terrainTiles.length,
  clonedFiles: cloneModes,
  nextStep: `LEITBILD_MAP_RELEASE_DIR=${targetReleaseDir} bun run maps:promote`,
}, null, 2))
