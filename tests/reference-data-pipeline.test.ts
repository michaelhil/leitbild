import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ccByNcSa40, nlod20, repoOwned } from '../src/reference-data/licences.ts'
import { buildDataset, currentBuildId, promoteBuild } from '../src/reference-data/pipeline.ts'
import { manualSource } from '../src/reference-data/sources/manual.ts'
import {
  asDatasetId,
  type DatasetConfig,
  type NormalizedFeature,
  type TilebuildConfig,
} from '../src/reference-data/types.ts'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'

const fixturePath = join(import.meta.dir, 'fixtures', 'halden-zone.geojson')

const tilebuild: TilebuildConfig = {
  outputLayer: 'exclusion',
  globalMinZoom: 4,
  globalMaxZoom: 12,
  categories: [
    { category: 'exclusion', minZoom: 5, maxZoom: 12 },
  ],
}

const featureSchema = z.object({
  category: z.literal('exclusion'),
  name: z.string().min(1),
  floorM: z.number().nonnegative(),
  ceilingM: z.number().nonnegative(),
  source: z.string().min(1),
})

const validConfig: DatasetConfig = {
  id: asDatasetId('test-exclusion'),
  schemaVersion: 1,
  featureSchema,
  sources: [manualSource({ id: 'halden-zone-fixture', path: fixturePath })],
  tilebuild,
  licences: [repoOwned],
  featureToCategory: (f: NormalizedFeature): string => String(f.properties.category ?? 'unknown'),
}

const mkEnv = async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-refdata-'))
  return {
    referenceRoot: root,
    fetchCache: createFetchCache(join(root, 'sources')),
    skipTileBuild: true,
    now: () => new Date('2026-05-26T18:30:00Z'),
  }
}

describe('buildDataset', () => {
  test('happy path: writes sidecar, manifest, audit report', async () => {
    const env = await mkEnv()
    const outcome = await buildDataset(validConfig, env)
    expect(outcome.featureCount).toBe(2)
    const sidecar = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.features.geojson'), 'utf8'))
    expect(sidecar.type).toBe('FeatureCollection')
    expect(sidecar.features.length).toBe(2)
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.manifest.json'), 'utf8'))
    expect(manifest.datasetId).toBe('test-exclusion')
    expect(manifest.categories[0].featureCount).toBe(2)
    expect(manifest.licences[0].id).toBe('repo-owned')
    const audit = JSON.parse(await readFile(join(outcome.buildDir, 'audit-report.json'), 'utf8'))
    expect(audit.status).toBe('ok')
    expect(audit.errors).toEqual([])
  })

  test('audit hook throwing fails the build and writes failure report', async () => {
    const env = await mkEnv()
    const config: DatasetConfig = {
      ...validConfig,
      audit: () => { throw new Error('intentional audit failure') },
    }
    await expect(buildDataset(config, env)).rejects.toThrow(/audit failed/)
  })

  test('feature-schema rejection accumulates errors and fails', async () => {
    const env = await mkEnv()
    const strictSchema = z.object({
      category: z.literal('nope'),
      name: z.string(),
      floorM: z.number(),
      ceilingM: z.number(),
      source: z.string(),
    })
    const config: DatasetConfig = { ...validConfig, featureSchema: strictSchema }
    await expect(buildDataset(config, env)).rejects.toThrow(/audit failed/)
  })

  test('unknown licence is rejected at build time', async () => {
    const env = await mkEnv()
    const config: DatasetConfig = {
      ...validConfig,
      licences: [{
        id: 'made-up-licence-id' as never,
        name: 'Fake',
        url: '',
        attribution: 'fake',
        commercialUseAllowed: true,
        redistributionAllowed: true,
        shareAlike: false,
      } as never],
    }
    await expect(buildDataset(config, env)).rejects.toThrow(/unknown licence id/)
  })

  test('multiple licences are all recorded', async () => {
    const env = await mkEnv()
    const config: DatasetConfig = { ...validConfig, licences: [ccByNcSa40, nlod20] }
    const outcome = await buildDataset(config, env)
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.manifest.json'), 'utf8'))
    expect(manifest.licences.map((l: { id: string }) => l.id).sort()).toEqual(['cc-by-nc-sa-4.0', 'nlod-2.0'])
  })
})

describe('promoteBuild', () => {
  test('creates the current symlink pointing at the build', async () => {
    const env = await mkEnv()
    const outcome = await buildDataset(validConfig, env)
    await promoteBuild(env.referenceRoot, validConfig.id, outcome.buildId)
    const current = await currentBuildId(env.referenceRoot, validConfig.id)
    expect(current).toBe(outcome.buildId)
  })

  test('replaces the symlink on subsequent promote', async () => {
    const env = await mkEnv()
    const first = await buildDataset(validConfig, env)
    await promoteBuild(env.referenceRoot, validConfig.id, first.buildId)
    const second = await buildDataset(
      validConfig,
      { ...env, now: () => new Date('2026-05-26T19:00:00Z') },
    )
    await promoteBuild(env.referenceRoot, validConfig.id, second.buildId)
    const current = await currentBuildId(env.referenceRoot, validConfig.id)
    expect(current).toBe(second.buildId)
    expect(current).not.toBe(first.buildId)
  })

  test('rejects promote of a non-existent build', async () => {
    const env = await mkEnv()
    await expect(
      promoteBuild(env.referenceRoot, validConfig.id, 'does-not-exist' as never),
    ).rejects.toThrow(/build directory does not exist/)
  })

  test('promoted build directory contains the expected artifacts', async () => {
    const env = await mkEnv()
    const outcome = await buildDataset(validConfig, env)
    await promoteBuild(env.referenceRoot, validConfig.id, outcome.buildId)
    const currentPath = join(env.referenceRoot, 'releases', String(validConfig.id), 'current')
    const sidecarStat = await stat(join(currentPath, 'test-exclusion.features.geojson'))
    expect(sidecarStat.isFile()).toBe(true)
  })
})
