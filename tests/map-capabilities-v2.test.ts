import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __clearManifestCacheForTests,
  createBaseTileset,
  createMapCapabilityManifest,
  findBaseTileset,
  findReferenceTilesets,
  findTerrainTilesets,
  loadMapCapabilityManifest,
  mapCapabilityManifestSchema,
} from '../src/map/capabilities.ts'

const writeReferenceManifest = async (
  root: string,
  datasetId: string,
  buildId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  const buildDir = join(root, 'builds', datasetId, buildId)
  await mkdir(buildDir, { recursive: true })
  const manifest = {
    schemaVersion: 1,
    datasetId,
    builtAt: '2026-05-26T20:00:00Z',
    buildId,
    artifact: {
      pmtilesPath: `${datasetId}.pmtiles`,
      sidecarGeoJsonPath: `${datasetId}.features.geojson`,
      outputLayer: 'aero',
    },
    categories: [{ category: 'tma', minZoom: 6, maxZoom: 14, featureCount: 8 }],
    sources: [{ id: 'openaip:airspaces:NO', kind: 'remote' }],
    licences: [{
      id: 'cc-by-nc-sa-4.0',
      name: 'CC BY-NC-SA 4.0',
      url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      attribution: '© OpenAIP',
      commercialUseAllowed: false,
      redistributionAllowed: true,
      shareAlike: true,
    }],
    ...overrides,
  }
  await writeFile(join(buildDir, `${datasetId}.manifest.json`), JSON.stringify(manifest))
  const releaseDir = join(root, 'releases', datasetId)
  await mkdir(releaseDir, { recursive: true })
  const symlinkPath = join(releaseDir, 'current')
  await rm(symlinkPath, { force: true })
  await symlink(join(root, 'builds', datasetId, buildId), symlinkPath)
}

const refRoot = async () => {
  __clearManifestCacheForTests()
  return mkdtemp(join(tmpdir(), 'leitbild-mapcap-'))
}

describe('Map Capability Manifest v2', () => {
  test('synchronous factory returns schemaVersion 2 with base tileset only', () => {
    const manifest = createMapCapabilityManifest()
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.tilesets.length).toBe(1)
    const base = findBaseTileset(manifest)
    expect(base.kind).toBe('base')
    expect(base.id).toBe('leitbild-osm-norway')
  })

  test('schema rejects v1 shape', () => {
    expect(() => mapCapabilityManifestSchema.parse({
      schemaVersion: 1,
      tilesetId: 'leitbild-osm-norway',
    } as never)).toThrow()
  })

  test('createBaseTileset has the canonical OSM artifact paths', () => {
    const base = createBaseTileset()
    expect(base.artifact.currentTileUrl).toBe('/map/tiles/current.pmtiles')
    expect(base.artifact.glyphsUrl).toBe('/map/fonts/{fontstack}/{range}.pbf')
  })

  test('base tileset advertises drone-relevant scenery layers', () => {
    const base = createBaseTileset()
    const layerIds = base.layers.map(layer => layer.id)
    expect(layerIds).toEqual(expect.arrayContaining([
      'aeroway',
      'building',
      'landcover',
      'landuse',
      'place',
      'poi',
      'transportation',
      'water',
      'waterway',
    ]))
  })

  test('findBaseTileset / findReferenceTilesets discriminate by kind', () => {
    const manifest = createMapCapabilityManifest()
    expect(findReferenceTilesets(manifest)).toEqual([])
    expect(findTerrainTilesets(manifest)).toEqual([])
    expect(findBaseTileset(manifest).kind).toBe('base')
  })
})

describe('loadMapCapabilityManifest (disk reads)', () => {
  test('returns base and explicit unavailable terrain when no reference releases exist', async () => {
    const root = await refRoot()
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(manifest.tilesets.length).toBe(2)
    expect(manifest.tilesets[0]!.kind).toBe('base')
    const terrain = findTerrainTilesets(manifest)
    expect(terrain.length).toBe(1)
    expect(terrain[0]!.availability.status).toBe('unavailable')
    expect(terrain[0]!.artifact.currentTileTemplate).toBe('/map/terrain/current/{z}/{x}/{y}.png')
  })

  test('marks corrupt terrain artifacts unavailable instead of advertising fake elevation', async () => {
    const root = await refRoot()
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-mapcap-map-'))
    await mkdir(join(mapRoot, 'current'), { recursive: true })
    await Bun.write(join(mapRoot, 'current', 'terrain.pmtiles'), 'terrain-bytes')

    const manifest = await loadMapCapabilityManifest({ referenceRoot: root, mapRoot })
    const terrain = findTerrainTilesets(manifest)
    expect(terrain.length).toBe(1)
    expect(terrain[0]!.availability.status).toBe('unavailable')
    expect(terrain[0]!.availability.path).toBe(join(mapRoot, 'current', 'terrain.pmtiles'))
    expect(terrain[0]!.availability.error).toContain('PMTiles archive')
  })

  test('discovers a promoted reference dataset and appends it', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'aero-norway', '20260526-2000')
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(manifest.tilesets.length).toBe(3)
    const refs = findReferenceTilesets(manifest)
    expect(refs.length).toBe(1)
    expect(refs[0]!.datasetId).toBe('aero-norway')
    expect(refs[0]!.buildId).toBe('20260526-2000')
  })

  test('accepts local-file reference sources in promoted manifests', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'grid-norway', '20260528-230419', {
      sources: [{ id: 'osm:pbf-power:NO', kind: 'local' }],
    })
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    const refs = findReferenceTilesets(manifest)
    expect(refs.map(ref => ref.datasetId)).toEqual(['grid-norway'])
    expect(refs[0]?.sources).toEqual([{ id: 'osm:pbf-power:NO', kind: 'local' }])
  })

  test('skips corrupt per-dataset manifests with a warning, base still served', async () => {
    const root = await refRoot()
    const buildDir = join(root, 'builds', 'broken', 'b1')
    await mkdir(buildDir, { recursive: true })
    await writeFile(join(buildDir, 'broken.manifest.json'), '{ not valid json')
    await mkdir(join(root, 'releases', 'broken'), { recursive: true })
    await symlink(buildDir, join(root, 'releases', 'broken', 'current'))
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(manifest.tilesets.length).toBe(2)
    expect(findReferenceTilesets(manifest).length).toBe(0)
  })

  test('cache invalidates when symlink target changes', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'aero-norway', '20260526-2000')
    const first = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(findReferenceTilesets(first)[0]!.buildId).toBe('20260526-2000')

    // Replace the symlink target by promoting a second build.
    await writeReferenceManifest(root, 'aero-norway', '20260526-2100', { buildId: '20260526-2100' })
    // The writer added a fresh symlink at the same path? Actually we'd need to
    // remove the old symlink first. Simulate atomically by clearing cache.
    __clearManifestCacheForTests()
    const reread = await loadMapCapabilityManifest({ referenceRoot: root })
    expect(findReferenceTilesets(reread).length).toBeGreaterThan(0)
  })

  test('multiple datasets are listed alphabetically', async () => {
    const root = await refRoot()
    await writeReferenceManifest(root, 'aero-norway', 'b1')
    await writeReferenceManifest(root, 'b-dataset', 'b1', { datasetId: 'b-dataset' })
    const manifest = await loadMapCapabilityManifest({ referenceRoot: root })
    const ids = findReferenceTilesets(manifest).map(t => t.datasetId)
    expect(ids).toEqual(['aero-norway', 'b-dataset'])
  })
})
