import { describe, expect, test } from 'bun:test'
import { buildSceneryTilesetDocument } from '../src/map/scenery-tileset.ts'
import type { SceneryAssetTileSummary, SceneryTilesetTile } from '../src/map/scenery.ts'

const tileSummary = (config: {
  readonly z: number
  readonly x: number
  readonly y: number
  readonly byteLength?: number
  readonly buildings?: number
}): SceneryAssetTileSummary => ({
  recipeId: 'drone-urban-flight',
  z: config.z,
  x: config.x,
  y: config.y,
  byteLength: config.byteLength ?? 1_000,
  centerLon: 10.75,
  centerLat: 59.91,
  bounds: { minLon: 10.7, minLat: 59.9, maxLon: 10.8, maxLat: 60 },
  boundingSphere: { centerLon: 10.75, centerLat: 59.91, centerHeightM: 6, radiusM: 900 },
  lod: { zoom: config.z, geometricErrorM: config.z === 12 ? 32 : config.z === 13 ? 16 : 8, maxScreenSpaceError: 16 },
  minHeightM: 0,
  maxHeightM: 24,
  featureCounts: {
    polygons: config.buildings ?? 1,
    lines: 1,
    labels: 0,
    buildings: config.buildings ?? 1,
    roads: 1,
    water: 0,
    vegetation: 0,
  },
})

const createTileset = (
  tiles: ReadonlyArray<SceneryAssetTileSummary>,
) => buildSceneryTilesetDocument({
  tilesetId: 'leitbild-scenery-norway',
  sourceTilesetId: 'leitbild-osm-norway',
  sourcePmtilesPath: '/tmp/norway.pmtiles',
  builtAt: '2026-06-10T00:00:00Z',
  bounds: { minLon: 10.6, minLat: 59.8, maxLon: 10.9, maxLat: 60.05 },
  zooms: [...new Set(tiles.map(tile => tile.z))].sort((left, right) => left - right),
  lodLevels: [...new Set(tiles.map(tile => tile.z))]
    .sort((left, right) => left - right)
    .map(zoom => ({ zoom, geometricErrorM: zoom === 12 ? 32 : zoom === 13 ? 16 : 8, maxScreenSpaceError: 16 })),
  inputArtifacts: [{
    kind: 'base-vector-pmtiles',
    id: 'leitbild-osm-norway',
    path: '/tmp/norway.pmtiles',
    required: true,
  }],
  recipes: [{ id: 'drone-urban-flight' }],
  outputRoot: '/tmp/scenery',
  counts: {
    decodedTileCount: tiles.length,
    emptyTileCount: 0,
    writtenTileCount: tiles.length,
    polygons: tiles.reduce((sum, tile) => sum + tile.featureCounts.polygons, 0),
    lines: tiles.reduce((sum, tile) => sum + tile.featureCounts.lines, 0),
    labels: 0,
    buildings: tiles.reduce((sum, tile) => sum + tile.featureCounts.buildings, 0),
    roads: tiles.reduce((sum, tile) => sum + tile.featureCounts.roads, 0),
    water: 0,
    vegetation: 0,
    bytes: tiles.reduce((sum, tile) => sum + tile.byteLength, 0),
  },
  tiles,
})

const collectContentUris = (
  tile: SceneryTilesetTile,
): ReadonlyArray<string> => [
  ...(tile.content ? [tile.content.uri] : []),
  ...(tile.children ?? []).flatMap(collectContentUris),
]

const findTile = (
  tile: SceneryTilesetTile,
  key: string,
): SceneryTilesetTile | null => {
  if (tile.extras?.leitbild?.tileKey === key) return tile
  for (const child of tile.children ?? []) {
    const found = findTile(child, key)
    if (found) return found
  }
  return null
}

describe('Scenery 3D Tiles artifact', () => {
  test('builds a single hierarchical tileset entrypoint with relative GLB content URIs', () => {
    const tileset = createTileset([
      tileSummary({ z: 12, x: 2170, y: 1191, byteLength: 2_000 }),
      tileSummary({ z: 13, x: 4340, y: 2382, byteLength: 3_000 }),
      tileSummary({ z: 14, x: 8680, y: 4764, byteLength: 4_000 }),
    ])

    expect(tileset.asset.version).toBe('1.1')
    expect(tileset.asset.gltfUpAxis).toBe('z')
    expect(tileset.extras.leitbild.artifactFormat).toBe('3d-tiles')
    expect(collectContentUris(tileset.root)).toEqual([
      'drone-urban-flight/12/2170/1191.glb',
      'drone-urban-flight/13/4340/2382.glb',
      'drone-urban-flight/14/8680/4764.glb',
    ])
  })

  test('synthesizes parent nodes so child detail never has to replace bare ground directly', () => {
    const tileset = createTileset([
      tileSummary({ z: 14, x: 8680, y: 4764, byteLength: 4_000 }),
    ])

    expect(findTile(tileset.root, '13/4340/2382')).not.toBeNull()
    expect(findTile(tileset.root, '14/8680/4764')?.content?.uri).toBe('drone-urban-flight/14/8680/4764.glb')
    expect(findTile(tileset.root, '13/4340/2382')?.content).toBeUndefined()
    expect(findTile(tileset.root, '13/4340/2382')?.children?.length).toBe(1)
  })

  test('stores aggregate byte and feature metadata for renderer cache accounting', () => {
    const tileset = createTileset([
      tileSummary({ z: 13, x: 4340, y: 2382, byteLength: 3_000, buildings: 3 }),
      tileSummary({ z: 14, x: 8680, y: 4764, byteLength: 4_000, buildings: 4 }),
    ])

    const parent = findTile(tileset.root, '13/4340/2382')
    expect(parent?.extras?.leitbild?.aggregateByteLength).toBe(7_000)
    expect(parent?.extras?.leitbild?.aggregateFeatureCounts.buildings).toBe(7)
    expect(parent?.content?.extras?.leitbild?.byteLength).toBe(3_000)
  })
})
