import { copyFile, link, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { readTerrainPmtilesMetadata, type TerrainDemEncoding } from '../../src/map/terrain-artifact.ts'
import { createMapPipelineConfig } from './config.ts'

const requiredEnv = (key: string): string => {
  const value = process.env[key]
  if (value && value.trim().length > 0) return value
  throw new Error(`${key} is required; point it at a real Terrarium or Mapbox PNG DEM PMTiles artifact`)
}

const demEncodingFromEnv = (): TerrainDemEncoding => {
  const value = process.env.LEITBILD_TERRAIN_DEM_ENCODING ?? 'terrarium'
  if (value === 'terrarium' || value === 'mapbox') return value
  throw new Error(`unsupported LEITBILD_TERRAIN_DEM_ENCODING "${value}"`)
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

const config = createMapPipelineConfig()
const sourcePath = resolve(requiredEnv('LEITBILD_TERRAIN_PMTILES_PATH'))
const demEncoding = demEncodingFromEnv()

const sourceMetadata = await readTerrainPmtilesMetadata({ filePath: sourcePath, demEncoding })
const currentDir = await realpath(join(config.rootDir, 'current'))
const targetReleaseDir = resolve(config.releaseDir)
if (targetReleaseDir === currentDir) {
  throw new Error('refusing to ingest terrain directly into the active current release; set LEITBILD_MAP_BUILD_ID or LEITBILD_MAP_RELEASE_DIR to a new release directory')
}

await mkdir(targetReleaseDir, { recursive: true })

const clonedFiles = ['norway.pmtiles', 'style.json', 'capabilities.json'] as const
const cloneModes: Record<string, 'hardlink' | 'copy'> = {}
for (const fileName of clonedFiles) {
  const sourceFile = join(currentDir, fileName)
  await stat(sourceFile)
  cloneModes[fileName] = await hardlinkOrCopy(sourceFile, join(targetReleaseDir, fileName))
}

const currentBuildJsonPath = join(currentDir, 'build.json')
const currentBuild = await readJsonObject(currentBuildJsonPath)
const terrainTmpPath = join(targetReleaseDir, 'terrain.pmtiles.tmp')
const terrainTargetPath = join(targetReleaseDir, 'terrain.pmtiles')
await copyFile(sourcePath, terrainTmpPath)
await rename(terrainTmpPath, terrainTargetPath)
const targetMetadata = await readTerrainPmtilesMetadata({ filePath: terrainTargetPath, demEncoding })

await writeFile(join(targetReleaseDir, 'terrain.json'), `${JSON.stringify({
  ingestedAt: new Date().toISOString(),
  sourcePath,
  sourceFileName: basename(sourcePath),
  source: {
    demEncoding: sourceMetadata.demEncoding,
    sizeBytes: sourceMetadata.sizeBytes,
    minZoom: sourceMetadata.minZoom,
    maxZoom: sourceMetadata.maxZoom,
    bounds: sourceMetadata.bounds,
  },
  artifact: targetMetadata,
}, null, 2)}\n`)

await writeFile(join(targetReleaseDir, 'build.json'), `${JSON.stringify({
  ...currentBuild,
  buildId: config.buildId,
  builtAt: new Date().toISOString(),
  basedOnReleaseDir: currentDir,
  terrain: {
    sourcePath,
    demEncoding,
    artifactPath: terrainTargetPath,
    minZoom: targetMetadata.minZoom,
    maxZoom: targetMetadata.maxZoom,
    bounds: targetMetadata.bounds,
  },
  clonedFiles: cloneModes,
}, null, 2)}\n`)

console.log(JSON.stringify({
  releaseDir: targetReleaseDir,
  currentDir,
  terrain: targetMetadata,
  clonedFiles: cloneModes,
  nextStep: `LEITBILD_MAP_RELEASE_DIR=${targetReleaseDir} bun run maps:promote`,
}, null, 2))
