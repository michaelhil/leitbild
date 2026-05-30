import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  __clearManifestCacheForTests,
  createMapCapabilityManifest,
  findBaseTileset,
  mapCapabilityManifestSchema,
} from '../src/map/capabilities.ts'
import { currentPmtilesResponse, mapGlyphResponse, referenceDatasetPmtilesResponse } from '../src/map/artifacts.ts'
import { createLeitbildMapStyle } from '../src/map/style.ts'

const writeReferenceDataset = async (root: string, datasetId: string, buildId: string, bytes: string): Promise<void> => {
  const buildDir = join(root, 'builds', datasetId, buildId)
  await mkdir(buildDir, { recursive: true })
  await Bun.write(join(buildDir, `${datasetId}.pmtiles`), bytes)
  await writeFile(join(buildDir, `${datasetId}.manifest.json`), JSON.stringify({
    schemaVersion: 1,
    datasetId,
    builtAt: '2026-05-30T12:00:00Z',
    buildId,
    artifact: {
      pmtilesPath: `${datasetId}.pmtiles`,
      sidecarGeoJsonPath: `${datasetId}.features.geojson`,
      outputLayer: datasetId,
    },
    categories: [{ category: 'line', minZoom: 0, maxZoom: 14, featureCount: 1 }],
    sources: [{ id: 'test:source', kind: 'local' }],
    licences: [{
      id: 'test',
      name: 'Test Licence',
      url: 'https://example.test/licence',
      attribution: 'Test attribution',
      commercialUseAllowed: true,
      redistributionAllowed: true,
      shareAlike: false,
    }],
  }))
  const releaseDir = join(root, 'releases', datasetId)
  await mkdir(releaseDir, { recursive: true })
  const currentLink = join(releaseDir, 'current')
  await rm(currentLink, { force: true })
  await symlink(buildDir, currentLink)
}

describe('vector map artifacts', () => {
  test('declares the canonical vector tile capabilities', () => {
    const manifest = mapCapabilityManifestSchema.parse(createMapCapabilityManifest())
    expect(manifest.schemaVersion).toBe(2)
    const base = findBaseTileset(manifest)
    expect(base.artifact.format).toBe('pmtiles')
    expect(base.artifact.currentTileUrl).toBe('/map/tiles/current.pmtiles')
    expect(base.layers.map(layer => layer.id)).toContain('transportation')
    expect(base.layers.map(layer => layer.id)).toContain('poi')
    expect(base.layers.map(layer => layer.id)).toContain('landuse')
  })

  test('style uses only the self-hosted PMTiles vector source', () => {
    const style = createLeitbildMapStyle()

    expect(style.sources['leitbild-osm']).toEqual({
      type: 'vector',
      url: 'pmtiles:///map/tiles/current.pmtiles',
      attribution: '© OpenStreetMap contributors © OpenMapTiles',
    })
    expect(JSON.stringify(style)).not.toContain('"raster"')
    expect(style.glyphs).toBe('/map/fonts/{fontstack}/{range}.pbf')
  })

  test('style supports light and dark vector themes without changing sources', () => {
    const lightStyle = createLeitbildMapStyle('light')
    const darkStyle = createLeitbildMapStyle('dark')

    expect(darkStyle.sources).toEqual(lightStyle.sources)
    expect(darkStyle.name).toContain('dark')
    expect(JSON.stringify(darkStyle.layers)).toContain('#0e1521')
  })

  test('PMTiles serving supports byte ranges and fails visibly when missing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const currentDir = join(rootDir, 'current')
    await mkdir(currentDir)
    await Bun.write(join(currentDir, 'norway.pmtiles'), '0123456789')

    const rangeResponse = await currentPmtilesResponse(new Request('http://localhost/map/tiles/current.pmtiles', {
      headers: { range: 'bytes=2-5' },
    }), { rootDir })
    expect(rangeResponse.status).toBe(206)
    expect(rangeResponse.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await rangeResponse.text()).toBe('2345')

    const missingResponse = await currentPmtilesResponse(new Request('http://localhost/map/tiles/current.pmtiles'), {
      rootDir: join(rootDir, 'missing'),
    })
    expect(missingResponse.status).toBe(503)
    expect(await missingResponse.json()).toMatchObject({ ok: false, error: 'vector map artifact unavailable' })
  })

  test('reference dataset PMTiles route serves promoted datasets from the manifest', async () => {
    __clearManifestCacheForTests()
    const referenceRoot = await mkdtemp(join(tmpdir(), 'leitbild-reference-test-'))
    await writeReferenceDataset(referenceRoot, 'grid-norway', '20260530-120000', 'reference-bytes')

    const served = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/grid-norway/current/grid-norway.pmtiles',
      { headers: { range: 'bytes=0-8' } },
    ), new URL('http://localhost/map/datasets/grid-norway/current/grid-norway.pmtiles'), { referenceRoot })
    expect(served?.status).toBe(206)
    expect(served?.headers.get('content-range')).toBe('bytes 0-8/15')
    expect(await served?.text()).toBe('reference')

    const unknown = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/missing/current/missing.pmtiles',
    ), new URL('http://localhost/map/datasets/missing/current/missing.pmtiles'), { referenceRoot })
    expect(unknown?.status).toBe(404)
  })

  test('reference dataset PMTiles route rejects unsafe paths', async () => {
    __clearManifestCacheForTests()
    const referenceRoot = await mkdtemp(join(tmpdir(), 'leitbild-reference-test-'))
    await writeReferenceDataset(referenceRoot, 'grid-norway', '20260530-120000', 'reference-bytes')

    const invalidDataset = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/grid%2Fnorway/current/grid-norway.pmtiles',
    ), new URL('http://localhost/map/datasets/grid%2Fnorway/current/grid-norway.pmtiles'), { referenceRoot })
    expect(invalidDataset?.status).toBe(400)

    const invalidFile = await referenceDatasetPmtilesResponse(new Request(
      'http://localhost/map/datasets/grid-norway/current/grid-norway.txt',
    ), new URL('http://localhost/map/datasets/grid-norway/current/grid-norway.txt'), { referenceRoot })
    expect(invalidFile?.status).toBe(400)
  })

  test('glyph serving honors the self-hosted map font contract', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'leitbild-map-test-'))
    const glyphDir = join(rootDir, 'fonts', 'Noto Sans Regular')
    await mkdir(glyphDir, { recursive: true })
    await Bun.write(join(glyphDir, '0-255.pbf'), 'glyph-bytes')

    const served = await mapGlyphResponse(new URL('http://localhost/map/fonts/Noto%20Sans%20Regular/0-255.pbf'), { rootDir })
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toBe('application/x-protobuf')
    expect(await served?.text()).toBe('glyph-bytes')

    const missing = await mapGlyphResponse(new URL('http://localhost/map/fonts/Noto%20Sans%20Regular/256-511.pbf'), { rootDir })
    expect(missing?.status).toBe(404)

    const invalidRange = await mapGlyphResponse(new URL('http://localhost/map/fonts/Noto%20Sans%20Regular/0-255.txt'), { rootDir })
    expect(invalidRange?.status).toBe(400)
  })
})
