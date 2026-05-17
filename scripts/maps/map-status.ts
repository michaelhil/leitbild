import { readdir, readlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
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

console.log(JSON.stringify({
  rootDir: config.rootDir,
  sourcePath: config.sourcePath,
  sourceSizeBytes: await sizeOf(config.sourcePath),
  currentTarget,
  currentPmtilesSizeBytes: await sizeOf(join(config.rootDir, 'current', 'norway.pmtiles')),
  releaseCount: releases.length,
  releases: releases.sort(),
}, null, 2))
