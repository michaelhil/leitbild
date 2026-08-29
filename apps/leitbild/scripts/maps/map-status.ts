import { readdir, readlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readTerrainPmtilesMetadata } from '../../src/map/terrain-artifact.ts'
import { createMapPipelineConfig } from './config.ts'

const config = createMapPipelineConfig()

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false
    throw err
  }
}

const sizeOf = async (path: string): Promise<number | null> => {
  if (!await exists(path)) return null
  return (await stat(path)).size
}

const releasesRoot = join(config.rootDir, 'releases', 'leitbild-osm-norway')
const releases = await exists(releasesRoot)
  ? await readdir(releasesRoot)
  : []

let currentTarget: string | null = null
try {
  currentTarget = await readlink(join(config.rootDir, 'current'))
} catch (err) {
  if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err
}

const terrainPath = join(config.rootDir, 'current', 'terrain.pmtiles')
const sceneryTilesetPath = join(config.rootDir, 'current', 'scenery', 'tileset.json')
let terrain: { readonly status: 'available'; readonly metadata: Awaited<ReturnType<typeof readTerrainPmtilesMetadata>> } | { readonly status: 'unavailable'; readonly error: string }
try {
  terrain = {
    status: 'available',
    metadata: await readTerrainPmtilesMetadata({ filePath: terrainPath }),
  }
} catch (err) {
  terrain = {
    status: 'unavailable',
    error: err instanceof Error ? err.message : String(err),
  }
}

console.log(JSON.stringify({
  rootDir: config.rootDir,
  sourcePath: config.sourcePath,
  sourceSizeBytes: await sizeOf(config.sourcePath),
  currentTarget,
  currentPmtilesSizeBytes: await sizeOf(join(config.rootDir, 'current', 'norway.pmtiles')),
  currentTerrainPmtilesSizeBytes: await sizeOf(terrainPath),
  currentSceneryTilesetSizeBytes: await sizeOf(sceneryTilesetPath),
  terrain,
  releaseCount: releases.length,
  releases: releases.sort(),
}, null, 2))
