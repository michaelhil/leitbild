import { describe, expect, test } from 'bun:test'
import { compileSceneryGlbTile } from '../src/map/scenery-glb.ts'
import type { SceneryTile } from '../src/map/scenery.ts'
import {
  droneSceneryTileCacheBudget,
  estimateDroneSceneryTileBytesForCache,
} from '../src/ui/drone/drone-scenery-tiles.ts'

const readAscii = (
  bytes: Uint8Array,
  start: number,
  length: number,
): string =>
  new TextDecoder().decode(bytes.slice(start, start + length))

const glbJson = (
  bytes: Uint8Array,
): Record<string, unknown> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  const jsonType = view.getUint32(16, true)
  expect(jsonType).toBe(0x4e4f534a)
  return JSON.parse(readAscii(bytes, 20, jsonLength).trim()) as Record<string, unknown>
}

const recordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    : []

const usedMaterialNames = (
  json: Record<string, unknown>,
): ReadonlySet<unknown> => {
  const materials = recordArray(json.materials)
  const meshes = recordArray(json.meshes)
  const used = new Set<unknown>()
  for (const mesh of meshes) {
    for (const primitive of recordArray(mesh.primitives)) {
      const materialIndex = primitive.material
      if (typeof materialIndex !== 'number') continue
      used.add(materials[materialIndex]?.name)
    }
  }
  return used
}

const tilePoint = (x: number, y: number): [number, number] => [x, y]

const testTile: SceneryTile = {
  schemaVersion: 1,
  tileEncoding: 'leitbild-scenery-feature-json-v1',
  recipeId: 'drone-urban-flight',
  sourceTilesetId: 'leitbild-osm-norway',
  tile: { z: 14, x: 8686, y: 4758, extent: 4096 },
  features: {
    polygons: [
      {
        id: 'building:1',
        sourceLayer: 'building',
        kind: 'building',
        className: 'commercial',
        rings: [[
          tilePoint(1600, 1800),
          tilePoint(1900, 1800),
          tilePoint(1900, 2100),
          tilePoint(1600, 2100),
          tilePoint(1600, 1800),
        ]],
        heightM: 26,
      },
      {
        id: 'water:1',
        sourceLayer: 'water',
        kind: 'water',
        className: 'river',
        rings: [[
          tilePoint(2150, 1850),
          tilePoint(2650, 1850),
          tilePoint(2650, 2180),
          tilePoint(2150, 2180),
          tilePoint(2150, 1850),
        ]],
      },
      {
        id: 'park:1',
        sourceLayer: 'landuse',
        kind: 'landuse',
        className: 'park',
        rings: [[
          tilePoint(1200, 2450),
          tilePoint(1850, 2450),
          tilePoint(1850, 3180),
          tilePoint(1200, 3180),
          tilePoint(1200, 2450),
        ]],
      },
    ],
    lines: [
      {
        id: 'road:1',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:1',
        kind: 'road',
        className: 'primary',
        name: 'Renderer Test Road',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(900, 1650),
          tilePoint(1800, 1900),
          tilePoint(3100, 1980),
        ],
        widthM: 17,
        verticalOffsetM: 0,
      },
      {
        id: 'waterway:1',
        sourceLayer: 'waterway',
        kind: 'waterway',
        className: 'stream',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(2500, 1700),
          tilePoint(2800, 2250),
        ],
        widthM: 7,
        verticalOffsetM: 0,
      },
    ],
    labels: [
      {
        id: 'poi:1',
        sourceLayer: 'poi',
        kind: 'poi',
        className: 'hospital',
        label: 'Hospital',
        point: tilePoint(1740, 1720),
      },
    ],
  },
}

const testTileAtZoom = (
  z: number,
  x: number,
  y: number,
): SceneryTile => ({
  ...testTile,
  tile: {
    ...testTile.tile,
    z,
    x,
    y,
  },
})

describe('drone scenery GLB compiler', () => {
  test('precompiles source-backed scenery into one valid GPU-ready GLB tile', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const { bytes, summary } = result!
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(view.getUint32(0, true)).toBe(0x46546c67)
    expect(view.getUint32(4, true)).toBe(2)
    expect(view.getUint32(8, true)).toBe(bytes.byteLength)
    expect(summary).toMatchObject({
      recipeId: 'drone-urban-flight',
      z: 14,
      x: 8686,
      y: 4758,
      lod: {
        zoom: 14,
      },
      featureCounts: {
        polygons: 3,
        lines: 2,
        labels: 1,
        buildings: 1,
        roads: 1,
        water: 2,
        vegetation: 1,
      },
    })
    expect(summary.bounds.minLon).toBeLessThan(summary.bounds.maxLon)
    expect(summary.bounds.minLat).toBeLessThan(summary.bounds.maxLat)
    expect(summary.boundingSphere.radiusM).toBeGreaterThan(100)
    expect(summary.lod.geometricErrorM).toBeGreaterThan(0)
    expect(summary.maxHeightM).toBeGreaterThan(summary.minHeightM)
  })

  test('bakes buildings, roads, water, vegetation, markings, lights, and POI primitives into the GLB', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const json = glbJson(result!.bytes)
    const materialNames = usedMaterialNames(json)

    expect(materialNames.has('cool building wall')).toBe(true)
    expect(materialNames.has('building facade trim')).toBe(true)
    expect([
      'building roof',
      'light building roof',
      'green copper roof',
      'red tile roof',
      'dark roof membrane',
    ].some(name => materialNames.has(name))).toBe(true)
    expect(materialNames.has('rooftop fixtures')).toBe(true)
    expect(materialNames.has('major road asphalt')).toBe(true)
    expect(materialNames.has('baked road markings')).toBe(true)
    expect(materialNames.has('water surface')).toBe(true)
    expect(materialNames.has('tree canopy')).toBe(true)
    expect(materialNames.has('street lamp glass')).toBe(true)
    expect(materialNames.has('poi beacon')).toBe(true)
  })

  test('keeps coarse scenery tiles as lightweight fallback silhouettes', () => {
    const coarseResult = compileSceneryGlbTile(testTileAtZoom(12, 2170, 1191))
    const fullResult = compileSceneryGlbTile(testTile)
    expect(coarseResult).not.toBeNull()
    expect(fullResult).not.toBeNull()

    const coarseMaterialNames = usedMaterialNames(glbJson(coarseResult!.bytes))
    expect(coarseResult!.bytes.byteLength).toBeLessThan(fullResult!.bytes.byteLength)
    expect(coarseMaterialNames.has('cool building wall')).toBe(true)
    expect([
      'building roof',
      'light building roof',
      'green copper roof',
      'red tile roof',
      'dark roof membrane',
    ].some(name => coarseMaterialNames.has(name))).toBe(true)
    expect(coarseMaterialNames.has('building windows')).toBe(false)
    expect(coarseMaterialNames.has('building facade trim')).toBe(false)
    expect(coarseMaterialNames.has('rooftop fixtures')).toBe(false)
    expect(coarseMaterialNames.has('baked road markings')).toBe(false)
    expect(coarseMaterialNames.has('street lamp glass')).toBe(false)
    expect(coarseMaterialNames.has('tree canopy')).toBe(false)
    expect(coarseMaterialNames.has('poi beacon')).toBe(false)
  })
})

describe('drone scenery runtime cache policy', () => {
  test('sizes visible tile residency from source content bytes without exhausting the working set', () => {
    const representativeLargeTile = {
      content: {
        extras: {
          leitbild: {
            byteLength: 12 * 1024 * 1024,
          },
        },
      },
    } as unknown as Parameters<typeof estimateDroneSceneryTileBytesForCache>[0]

    const estimatedBytes = estimateDroneSceneryTileBytesForCache(representativeLargeTile)
    expect(estimatedBytes).toBe(15 * 1024 * 1024)
    expect(estimatedBytes * 20).toBeLessThan(droneSceneryTileCacheBudget.maxBytes)
    expect(droneSceneryTileCacheBudget.unloadPercent).toBeLessThan(0.18)
  })
})
