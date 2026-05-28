import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGridNorwayDataset } from '../src/packs/electric-grid/datasets/grid-norway.ts'
import { compileGridReferenceGraph } from '../src/packs/electric-grid/reference-graph.ts'
import { gridReferenceFeatureSchema } from '../src/packs/electric-grid/schemas/grid-reference.ts'
import { buildOverpassPowerQuery, normaliseOverpassPowerElements, type HttpFetch } from '../src/packs/electric-grid/sources/overpass-power.ts'
import { buildDataset } from '../src/reference-data/pipeline.ts'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'

const fixturePath = (name: string): string => join(import.meta.dir, 'fixtures', name)

const overpassFixture = async (): Promise<unknown> =>
  JSON.parse(await readFile(fixturePath('overpass-power-sample.json'), 'utf8')) as unknown

const fixtureFetcher = (body: string): HttpFetch =>
  async (_url, init) => {
    expect(init?.method).toBe('POST')
    expect(init?.headers?.['user-agent']).toContain('Leitbild')
    expect(decodeURIComponent(String(init?.body ?? ''))).toContain('[out:json]')
    return new Response(body, { status: 200, headers: { etag: 'fixture-etag' } })
  }

const buildEnv = async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-grid-norway-'))
  return {
    root,
    env: {
      referenceRoot: root,
      fetchCache: createFetchCache(join(root, 'sources')),
      skipTileBuild: true,
      now: () => new Date('2026-05-28T10:00:00Z'),
    },
  }
}

describe('electric-grid reference data sources', () => {
  test('normalises Overpass power features into provenance-bearing grid reference features', async () => {
    const features = normaliseOverpassPowerElements(await overpassFixture(), 'osm:overpass-power:test')

    expect(features).toHaveLength(4)
    for (const feature of features) gridReferenceFeatureSchema.parse(feature.properties)
    expect(features.map(feature => feature.properties.category).sort()).toEqual([
      'line',
      'plant',
      'substation',
      'substation',
    ])
    expect(features[0]?.geometry.type).toBe('LineString')
    expect(features[0]?.properties).toMatchObject({
      source: 'osm:overpass-power:test',
      category: 'line',
      assetKind: 'branch',
      voltageKv: [420],
      frequencyHz: 50,
      circuits: 2,
      operator: 'Statnett',
      confidence: 'high',
    })
    expect(features[1]?.geometry.type).toBe('Polygon')
    expect(features[1]?.properties).toMatchObject({
      category: 'substation',
      voltageKv: [420, 132],
      geometrySource: 'osm-geometry',
    })
    expect(features[2]?.geometry.type).toBe('Point')
    expect(features[2]?.properties).toMatchObject({
      category: 'plant',
      plantSource: 'hydro',
      outputMw: 120,
    })
    expect(features[3]?.geometry.type).toBe('Point')
    expect(features[3]?.properties).toMatchObject({
      category: 'substation',
      geometrySource: 'bounds-centroid',
      confidence: 'low',
      propertyProvenance: 'unknown',
    })
  })

  test('builds a bounded Overpass query for power-network extraction', () => {
    const query = buildOverpassPowerQuery({
      bbox: { south: 58, west: 5, north: 62, east: 12 },
      timeoutSeconds: 120,
    })

    expect(query).toContain('[out:json][timeout:120]')
    expect(query).toContain('["power"~"^(line|minor_line|cable|substation|transformer|plant|generator)$"]')
    expect(query).toContain('(58,5,62,12)')
    expect(query).toContain('out body geom')
    expect(query).not.toContain('relation[')
  })

  test('rejects Overpass runtime remarks instead of treating timeout bodies as empty datasets', () => {
    expect(() => normaliseOverpassPowerElements({
      elements: [],
      remark: 'runtime error: Query timed out in "query" at line 4 after 181 seconds.',
    }, 'osm:overpass-power:test')).toThrow('server returned remark')
  })

  test('compiles reference features into an auditable node-branch graph', async () => {
    const features = normaliseOverpassPowerElements(await overpassFixture(), 'osm:overpass-power:test')
    const graph = compileGridReferenceGraph(features, { maxEndpointDistanceKm: 20 })

    expect(graph.nodes.length).toBe(3)
    expect(graph.branches.length).toBe(1)
    expect(graph.branches[0]).toMatchObject({
      category: 'line',
      fromNodeId: expect.any(String),
      toNodeId: expect.any(String),
      voltageKv: [420],
    })
    expect(graph.branches[0]?.lengthKm).toBeGreaterThan(20)
    expect(graph.audit).toMatchObject({
      nodeCount: 3,
      branchCount: 1,
      unresolvedBranchEndpointCount: 0,
      lowConfidenceFeatureCount: 1,
      voltageMissingCount: 2,
    })
    expect(graph.audit.warnings.some(warning => warning.includes('low confidence'))).toBe(true)
  })

  test('builds the grid-norway reference dataset through the shared pipeline', async () => {
    const { env } = await buildEnv()
    const body = await readFile(fixturePath('overpass-power-sample.json'), 'utf8')
    const dataset = createGridNorwayDataset({
      bbox: { south: 58, west: 5, north: 62, east: 12 },
      overpassFetchFn: fixtureFetcher(body),
      thresholds: {
        nodes: 3,
        branches: 1,
        maxUnresolvedEndpointFraction: 1,
      },
    })

    const outcome = await buildDataset(dataset, env)
    const sidecar = JSON.parse(await readFile(join(outcome.buildDir, 'grid-norway.features.geojson'), 'utf8')) as { readonly features: ReadonlyArray<unknown> }
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'grid-norway.manifest.json'), 'utf8')) as {
      readonly datasetId: string
      readonly sources: ReadonlyArray<{ readonly id: string }>
      readonly licences: ReadonlyArray<{ readonly id: string }>
    }

    expect(outcome.featureCount).toBe(4)
    expect(sidecar.features).toHaveLength(4)
    expect(manifest.datasetId).toBe('grid-norway')
    expect(manifest.sources.map(source => source.id)).toEqual(['osm:overpass-power:NO'])
    expect(manifest.licences.map(licence => licence.id)).toEqual(['osm-odbl-1.0'])
  })
})
