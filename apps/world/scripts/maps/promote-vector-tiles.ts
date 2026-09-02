import { lstat, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { createMapPipelineConfig } from './config.ts'

export const promoteVectorTiles = async (rootDir: string, releaseDir: string): Promise<void> => {
  const root = await realpath(rootDir)
  const release = await realpath(releaseDir)
  const relativeRelease = relative(join(root, 'releases'), release)
  if (!relativeRelease || relativeRelease.startsWith('..') || isAbsolute(relativeRelease)) throw new Error('Map release must be beneath the map releases directory')
  for (const name of ['norway.pmtiles', 'capabilities.json', 'style.json']) {
    const artifact = await stat(join(release, name))
    if (!artifact.isFile() || artifact.size === 0) throw new Error(`Missing map artifact: ${name}`)
  }
  const current = join(root, 'current')
  try {
    if (!(await lstat(current)).isSymbolicLink()) throw new Error('Map current path must be a symlink; refusing to replace data')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = join(root, `current.${crypto.randomUUID()}.next`)
  try {
    await symlink(release, next)
    await rename(next, current)
  } finally {
    await rm(next, { force: true })
  }
}

if (import.meta.main) {
  const config = createMapPipelineConfig()
  await promoteVectorTiles(config.rootDir, config.releaseDir)
  console.log(`Promoted vector tile release ${config.releaseDir}`)
}
