import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aeroFeatureSchema,
  aeroFeatureToCategory,
  aeroNorwayProductionThresholds,
  createAeroNorwayDataset,
  __internals,
} from '../src/packs/aviation/datasets/aero-norway.ts'
import { buildDataset, currentBuildId, promoteBuild } from '../src/reference-data/pipeline.ts'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'
import type { HttpFetch } from '../src/packs/aviation/sources/openaip.ts'

const fixturePath = (name: string) => join(import.meta.dir, 'fixtures', name)
const manualOverlayPath = join(import.meta.dir, '..', 'src', 'packs', 'aviation', 'data', 'halden-exclusion-zone.geojson')

const fixtureBody = (name: string): Promise<string> => readFile(fixturePath(name), 'utf8')

const sequentialFetcher = (bodies: ReadonlyArray<string>): HttpFetch => {
  let i = 0
  return async () => {
    if (i >= bodies.length) throw new Error(`sequentialFetcher: out of responses (call ${i + 1})`)
    const body = bodies[i]!
    i += 1
    return new Response(body, { status: 200, headers: { etag: `e${i}` } })
  }
}

const buildEnv = async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-aero-norway-'))
  return {
    root,
    env: {
      referenceRoot: root,
      fetchCache: createFetchCache(join(root, 'sources')),
      skipTileBuild: true,
      now: () => new Date('2026-05-26T21:30:00Z'),
    },
  }
}

const lowTestThresholds = { fir: 1, tma: 2, ctr: 1, airport: 3 }

describe('aero-norway dataset factory', () => {
  test('combines OpenAIP + GeoNorge + manual overlay end-to-end', async () => {
    const { env } = await buildEnv()
    const openaipPage1 = await fixtureBody('openaip-airspaces-no-page1.json')
    const openaipPage2 = await fixtureBody('openaip-airspaces-no-page2.json')
    const avinorXml = await fixtureBody('avinor-lufthavn-sample.xml')

    const dataset = createAeroNorwayDataset({
      openaipApiKey: 'test-key',
      openaipLimit: 4,
      openaipFetchFn: sequentialFetcher([openaipPage1, openaipPage2]),
      avinorFetchFn: sequentialFetcher([avinorXml]),
      manualOverlayPath,
      thresholds: lowTestThresholds,
    })

    const outcome = await buildDataset(dataset, env)

    // Expected feature count: openaip page 1 (4) + page 2 (2) + avinor (3) + manual (1) = 10
    expect(outcome.featureCount).toBe(10)

    // Sidecar GeoJSON exists and has the right number of features.
    const sidecar = JSON.parse(await readFile(join(outcome.buildDir, 'aero-norway.features.geojson'), 'utf8'))
    expect(sidecar.type).toBe('FeatureCollection')
    expect(sidecar.features.length).toBe(10)

    // Every feature passes the canonical aero union schema.
    for (const f of sidecar.features) aeroFeatureSchema.parse(f.properties)

    // Manifest reflects the right shape.
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'aero-norway.manifest.json'), 'utf8'))
    expect(manifest.datasetId).toBe('aero-norway')
    expect(manifest.licences.map((l: { id: string }) => l.id).sort()).toEqual([
      'cc-by-nc-sa-4.0', 'nlod-2.0', 'repo-owned',
    ])
    expect(manifest.sources.map((s: { id: string }) => s.id).sort()).toEqual([
      'geonorge:lufthavnpunkt_avinor',
      'manual:halden-exclusion-zone',
      'openaip:airspaces:NO',
    ])

    // Audit report is ok.
    const audit = JSON.parse(await readFile(join(outcome.buildDir, 'audit-report.json'), 'utf8'))
    expect(audit.status).toBe('ok')
    expect(audit.featureCount).toBe(10)
    expect(audit.categoryCounts.fir).toBe(1)
    expect(audit.categoryCounts.tma).toBe(2)
    expect(audit.categoryCounts.ctr).toBe(1)
    expect(audit.categoryCounts.airport).toBe(3)
    expect(audit.categoryCounts.exclusion).toBe(1)
    expect(audit.categoryCounts.restricted).toBe(1)
  })

  test('production thresholds fail the audit on the fixtures', async () => {
    const { env } = await buildEnv()
    const openaipPage1 = await fixtureBody('openaip-airspaces-no-page1.json')
    const openaipPage2 = await fixtureBody('openaip-airspaces-no-page2.json')
    const avinorXml = await fixtureBody('avinor-lufthavn-sample.xml')

    const dataset = createAeroNorwayDataset({
      openaipApiKey: 'test-key',
      openaipLimit: 4,
      openaipFetchFn: sequentialFetcher([openaipPage1, openaipPage2]),
      avinorFetchFn: sequentialFetcher([avinorXml]),
      manualOverlayPath,
      thresholds: aeroNorwayProductionThresholds,
    })

    await expect(buildDataset(dataset, env)).rejects.toThrow(/audit failed/)
  })

  test('promote lifecycle works against the real dataset', async () => {
    const { env } = await buildEnv()
    const openaipPage1 = await fixtureBody('openaip-airspaces-no-page1.json')
    const openaipPage2 = await fixtureBody('openaip-airspaces-no-page2.json')
    const avinorXml = await fixtureBody('avinor-lufthavn-sample.xml')

    const dataset = createAeroNorwayDataset({
      openaipApiKey: 'test-key',
      openaipLimit: 4,
      openaipFetchFn: sequentialFetcher([openaipPage1, openaipPage2]),
      avinorFetchFn: sequentialFetcher([avinorXml]),
      manualOverlayPath,
      thresholds: lowTestThresholds,
    })

    const outcome = await buildDataset(dataset, env)
    await promoteBuild(env.referenceRoot, dataset.id, outcome.buildId)
    const current = await currentBuildId(env.referenceRoot, dataset.id)
    expect(current).toBe(outcome.buildId)

    const released = join(env.referenceRoot, 'releases', String(dataset.id), 'current', 'aero-norway.features.geojson')
    const s = await stat(released)
    expect(s.isFile()).toBe(true)
  })

  test('factory throws when openaipApiKey is missing', () => {
    expect(() => createAeroNorwayDataset({ openaipApiKey: '' })).toThrow(/apiKey/)
  })
})

describe('aeroFeatureToCategory dispatch', () => {
  test('airport from geonorge:* source', () => {
    expect(aeroFeatureToCategory({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10, 60] },
      properties: { source: 'geonorge:lufthavnpunkt_avinor' },
    })).toBe('airport')
  })

  test('airspace category from openaip', () => {
    expect(aeroFeatureToCategory({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [] },
      properties: { source: 'openaip', category: 'tma' },
    })).toBe('tma')
  })

  test('exclusion category from manual overlay', () => {
    expect(aeroFeatureToCategory({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [] },
      properties: { source: 'manual', category: 'exclusion' },
    })).toBe('exclusion')
  })

  test('unknown source defaults to "unknown"', () => {
    expect(aeroFeatureToCategory({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [] },
      properties: { source: 'something-else' },
    })).toBe('unknown')
  })
})

describe('aero-norway internals', () => {
  test('unknownCategoryWarnings flags categories not in KNOWN_CATEGORIES', () => {
    const counts = new Map([['tma', 5], ['mystery', 2]])
    const warnings = __internals.unknownCategoryWarnings(counts)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('mystery')
  })

  test('KNOWN_CATEGORIES covers all expected aero categories', () => {
    for (const c of ['fir', 'tma', 'ctr', 'airport', 'exclusion', 'restricted', 'prohibited', 'danger']) {
      expect(__internals.KNOWN_CATEGORIES).toContain(c)
    }
  })
})
