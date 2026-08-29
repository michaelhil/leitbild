import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SceneryAssetTileset } from './scenery.ts'

export interface SceneryBuildQualityGate {
  readonly maxErrorTiles: number
  readonly maxWarningTiles: number
  readonly maxRiskyTiles: number
  readonly maxRiskScore: number
}

interface FileSystemError extends Error {
  readonly code?: string
}

const isFileSystemError = (error: unknown): error is FileSystemError =>
  error instanceof Error && typeof (error as FileSystemError).code === 'string'

const nonnegativeIntegerEnv = (
  key: string,
  defaultValue: number,
): number => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`)
  return value
}

export const sceneryBuildQualityGateFromEnv = (): SceneryBuildQualityGate => ({
  maxErrorTiles: nonnegativeIntegerEnv('LEITBILD_SCENERY_MAX_ERROR_TILES', 0),
  maxWarningTiles: nonnegativeIntegerEnv('LEITBILD_SCENERY_MAX_WARNING_TILES', Number.MAX_SAFE_INTEGER),
  maxRiskyTiles: nonnegativeIntegerEnv('LEITBILD_SCENERY_MAX_RISKY_TILES', Number.MAX_SAFE_INTEGER),
  maxRiskScore: nonnegativeIntegerEnv('LEITBILD_SCENERY_MAX_RISK_SCORE', Number.MAX_SAFE_INTEGER),
})

export const assertSceneryBuildQualityGate = (
  tileset: SceneryAssetTileset,
  gate: SceneryBuildQualityGate,
): void => {
  const quality = tileset.extras.leitbild.quality
  if (!quality) return
  const failures = [
    quality.errorTileCount > gate.maxErrorTiles
      ? `errorTileCount ${quality.errorTileCount} exceeds ${gate.maxErrorTiles}`
      : null,
    quality.warningTileCount > gate.maxWarningTiles
      ? `warningTileCount ${quality.warningTileCount} exceeds ${gate.maxWarningTiles}`
      : null,
    quality.riskyTileCount > gate.maxRiskyTiles
      ? `riskyTileCount ${quality.riskyTileCount} exceeds ${gate.maxRiskyTiles}`
      : null,
    quality.maxRiskScore > gate.maxRiskScore
      ? `maxRiskScore ${quality.maxRiskScore} exceeds ${gate.maxRiskScore}`
      : null,
  ].filter((failure): failure is string => failure !== null)
  if (failures.length === 0) return
  throw new Error(`scenery build quality gate failed: ${failures.join('; ')}`)
}

export const stagingSceneryRootFor = (
  outputRoot: string,
): string =>
  join(dirname(outputRoot), `.${basename(outputRoot)}.staging-${process.pid}-${Date.now()}`)

export const publishStagedSceneryArtifact = async (config: {
  readonly stagingRoot: string
  readonly outputRoot: string
}): Promise<void> => {
  const outputParent = dirname(config.outputRoot)
  await mkdir(outputParent, { recursive: true })
  const backupRoot = join(outputParent, `.${basename(config.outputRoot)}.backup-${process.pid}-${Date.now()}`)
  let movedExisting = false

  try {
    const stagingStat = await lstat(config.stagingRoot)
    if (!stagingStat.isDirectory()) throw new Error(`scenery staging root is not a directory: ${config.stagingRoot}`)
    await rm(backupRoot, { recursive: true, force: true })
    try {
      await rename(config.outputRoot, backupRoot)
      movedExisting = true
    } catch (error) {
      if (!isFileSystemError(error) || error.code !== 'ENOENT') throw error
    }

    try {
      await rename(config.stagingRoot, config.outputRoot)
    } catch (error) {
      if (movedExisting) {
        try {
          await rename(backupRoot, config.outputRoot)
        } catch (rollbackError) {
          const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          throw new Error(`failed to publish staged scenery and rollback also failed: ${detail}`)
        }
      }
      throw error
    }

    if (movedExisting) await rm(backupRoot, { recursive: true, force: true })
  } catch (error) {
    await rm(config.stagingRoot, { recursive: true, force: true })
    if (!movedExisting) await rm(backupRoot, { recursive: true, force: true })
    throw error
  }
}
