import { describe, expect, test } from 'bun:test'
import { buildSceneryTilesetDocument } from '../src/map/scenery-tileset.ts'
import type { SceneryAssetTileSummary, SceneryTilesetTile } from '../src/map/scenery.ts'

const tileSummary = (config: {
  readonly z: number
  readonly x: number
  readonly y: number
  readonly byteLength?: number
  readonly buildings?: number
  readonly riskScore?: number
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
  ...(config.riskScore === undefined
    ? {}
    : {
        quality: {
          riskScore: config.riskScore,
          findingCount: 1,
          warningCount: 1,
          errorCount: 0,
          vertexCount: 120,
          triangleCount: 80,
          horizontalPlaneCount: 24,
          closeHorizontalOverlapCount: 1,
          sameMaterialHorizontalOverlapCount: 0,
          duplicateHorizontalTriangleCount: 0,
          duplicateSourceRefCount: 0,
          outOfBoundsPointCount: 0,
          degenerateTriangleCount: 0,
          minHorizontalGapM: 0.02,
          findings: [{
            severity: 'warning' as const,
            code: 'scenery.depth.close_horizontal_overlap',
            message: 'Different horizontal material planes overlap with too little vertical separation.',
            count: 1,
            minGapM: 0.02,
          }],
        },
      }),
})

const createTileset = (
  tiles: ReadonlyArray<SceneryAssetTileSummary>,
  options: {
    readonly zooms?: ReadonlyArray<number>
  } = {},
) => buildSceneryTilesetDocument({
  tilesetId: 'leitbild-scenery-norway',
  sourceTilesetId: 'leitbild-osm-norway',
  sourcePmtilesPath: '/tmp/norway.pmtiles',
  builtAt: '2026-06-10T00:00:00Z',
  bounds: createTilesetBounds,
  zooms: options.zooms ?? [...new Set(tiles.map(tile => tile.z))].sort((left, right) => left - right),
  lodLevels: [...new Set(options.zooms ?? tiles.map(tile => tile.z))]
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

const transformTranslation = (
  tile: SceneryTilesetTile,
): { readonly x: number; readonly z: number } => ({
  x: tile.transform?.[12] ?? 0,
  z: tile.transform?.[14] ?? 0,
})

const metersPerDegreeLat = 111_320
const createTilesetBounds = { minLon: 10.6, minLat: 59.8, maxLon: 10.9, maxLat: 60.05 } as const

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const tileCenterLonLat = (tile: { readonly z: number; readonly x: number; readonly y: number }): {
  readonly lon: number
  readonly lat: number
} => {
  const size = 2 ** tile.z
  const lon = (tile.x + 0.5) / size * 360 - 180
  const n = Math.PI - 2 * Math.PI * (tile.y + 0.5) / size
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lon, lat }
}

const expectedOffsetFor = (tile: { readonly z: number; readonly x: number; readonly y: number }): {
  readonly x: number
  readonly z: number
} => {
  const origin = {
    lon: (createTilesetBounds.minLon + createTilesetBounds.maxLon) / 2,
    lat: (createTilesetBounds.minLat + createTilesetBounds.maxLat) / 2,
  }
  const center = tileCenterLonLat(tile)
  return {
    x: (center.lon - origin.lon) * metersPerDegreeLonAt(origin.lat),
    z: -(center.lat - origin.lat) * metersPerDegreeLat,
  }
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

  test('starts hierarchy at the configured coarse scenery zoom instead of global z0 ancestors', () => {
    const tileset = createTileset([
      tileSummary({ z: 12, x: 2170, y: 1191, byteLength: 2_000 }),
      tileSummary({ z: 13, x: 4340, y: 2382, byteLength: 3_000 }),
      tileSummary({ z: 14, x: 8680, y: 4764, byteLength: 4_000 }),
    ], { zooms: [12, 13, 14] })

    expect(tileset.root.children?.map(child => child.extras?.leitbild?.tileKey)).toEqual(['12/2170/1191'])
    expect(findTile(tileset.root, '0/0/0')).toBeNull()
    expect(findTile(tileset.root, '11/1085/595')).toBeNull()
  })

  test('synthesizes configured local parent nodes when detail content is sparse', () => {
    const tileset = createTileset([
      tileSummary({ z: 14, x: 8680, y: 4764, byteLength: 4_000 }),
    ], { zooms: [12, 13, 14] })

    expect(findTile(tileset.root, '12/2170/1191')).not.toBeNull()
    expect(findTile(tileset.root, '13/4340/2382')).not.toBeNull()
    expect(findTile(tileset.root, '14/8680/4764')?.content?.uri).toBe('drone-urban-flight/14/8680/4764.glb')
    expect(findTile(tileset.root, '13/4340/2382')?.content).toBeUndefined()
    expect(findTile(tileset.root, '13/4340/2382')?.children?.length).toBe(1)
  })

  test('uses relative child transforms so hierarchical placement does not accumulate absolute offsets', () => {
    const tileset = createTileset([
      tileSummary({ z: 12, x: 2170, y: 1191, byteLength: 2_000 }),
      tileSummary({ z: 13, x: 4340, y: 2382, byteLength: 3_000 }),
      tileSummary({ z: 14, x: 8680, y: 4764, byteLength: 4_000 }),
    ], { zooms: [12, 13, 14] })
    const z12 = findTile(tileset.root, '12/2170/1191')
    const z13 = findTile(tileset.root, '13/4340/2382')
    const z14 = findTile(tileset.root, '14/8680/4764')
    expect(z12).not.toBeNull()
    expect(z13).not.toBeNull()
    expect(z14).not.toBeNull()

    const t12 = transformTranslation(z12!)
    const t13 = transformTranslation(z13!)
    const t14 = transformTranslation(z14!)
    const expected13 = expectedOffsetFor({ z: 13, x: 4340, y: 2382 })
    const expected14 = expectedOffsetFor({ z: 14, x: 8680, y: 4764 })
    expect(t12.x + t13.x).toBeCloseTo(expected13.x, 6)
    expect(t12.z + t13.z).toBeCloseTo(expected13.z, 6)
    expect(t12.x + t13.x + t14.x).toBeCloseTo(expected14.x, 6)
    expect(t12.z + t13.z + t14.z).toBeCloseTo(expected14.z, 6)
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

  test('summarizes tile quality risk for systematic scenery cleanup', () => {
    const tileset = createTileset([
      tileSummary({ z: 14, x: 8680, y: 4764, byteLength: 4_000, riskScore: 12 }),
      tileSummary({ z: 14, x: 8681, y: 4764, byteLength: 5_000, riskScore: 45 }),
      tileSummary({ z: 14, x: 8682, y: 4764, byteLength: 6_000 }),
    ], { zooms: [12, 13, 14] })

    expect(tileset.extras.leitbild.quality?.maxRiskScore).toBe(45)
    expect(tileset.extras.leitbild.quality?.riskyTileCount).toBe(2)
    expect(tileset.extras.leitbild.quality?.warningTileCount).toBe(2)
    expect(tileset.extras.leitbild.quality?.topRiskTiles.map(tile => `${tile.z}/${tile.x}/${tile.y}`)).toEqual([
      '14/8681/4764',
      '14/8680/4764',
    ])
    expect(findTile(tileset.root, '14/8681/4764')?.content?.extras?.leitbild?.quality?.riskScore).toBe(45)
  })
})
