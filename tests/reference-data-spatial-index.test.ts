import { describe, expect, test } from 'bun:test'
import { spatialIndexFromFeatures } from '../src/reference-data/spatial-index.ts'
import type { NormalizedFeature } from '../src/reference-data/types.ts'

const feature = (config: {
  readonly id: string
  readonly category: string
  readonly floorM?: number
  readonly ceilingM?: number
  readonly bbox: readonly [number, number, number, number]
}): NormalizedFeature => ({
  type: 'Feature',
  id: config.id,
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [config.bbox[0], config.bbox[1]],
      [config.bbox[2], config.bbox[1]],
      [config.bbox[2], config.bbox[3]],
      [config.bbox[0], config.bbox[3]],
      [config.bbox[0], config.bbox[1]],
    ]],
  },
  properties: {
    category: config.category,
    ...(config.floorM !== undefined ? { floorM: config.floorM } : {}),
    ...(config.ceilingM !== undefined ? { ceilingM: config.ceilingM } : {}),
  },
})

const fixtures: ReadonlyArray<NormalizedFeature> = [
  feature({ id: 'fir-1', category: 'fir', bbox: [0, 0, 100, 100] }),
  feature({ id: 'tma-oslo', category: 'tma', floorM: 0, ceilingM: 3000, bbox: [10, 10, 20, 20] }),
  feature({ id: 'ctr-engm', category: 'ctr', floorM: 0, ceilingM: 1500, bbox: [12, 12, 18, 18] }),
  feature({ id: 'far-away', category: 'tma', bbox: [200, 200, 210, 210] }),
]

describe('spatialIndexFromFeatures', () => {
  test('returns all polygons containing a point', () => {
    const idx = spatialIndexFromFeatures(fixtures)
    const hits = idx.featuresContainingPoint([15, 15])
    const ids = hits.map(f => f.id).sort()
    expect(ids).toEqual(['ctr-engm', 'fir-1', 'tma-oslo'])
  })

  test('filters by category', () => {
    const idx = spatialIndexFromFeatures(fixtures)
    const hits = idx.featuresContainingPoint([15, 15], { categories: ['ctr'] })
    expect(hits.map(f => f.id)).toEqual(['ctr-engm'])
  })

  test('filters by altitude — below ceiling, above floor', () => {
    const idx = spatialIndexFromFeatures(fixtures)
    const hits = idx.featuresContainingPoint([15, 15], { altitudeM: 2000 })
    // CTR ceiling is 1500m so excluded; TMA ceiling 3000m kept; FIR has no limits so kept.
    expect(hits.map(f => f.id).sort()).toEqual(['fir-1', 'tma-oslo'])
  })

  test('filters by altitude — above all ceilings', () => {
    const idx = spatialIndexFromFeatures(fixtures)
    const hits = idx.featuresContainingPoint([15, 15], { altitudeM: 10000 })
    // Only FIR (no ceiling) remains.
    expect(hits.map(f => f.id)).toEqual(['fir-1'])
  })

  test('bbox pre-filter eliminates far-away polygons', () => {
    const idx = spatialIndexFromFeatures(fixtures)
    const hits = idx.featuresContainingPoint([15, 15])
    expect(hits.find(f => f.id === 'far-away')).toBeUndefined()
  })

  test('empty result when point is outside all polygons', () => {
    const idx = spatialIndexFromFeatures(fixtures)
    const hits = idx.featuresContainingPoint([-50, -50])
    expect(hits).toEqual([])
  })

  test('non-polygon geometries are ignored', () => {
    const idx = spatialIndexFromFeatures([
      ...fixtures,
      {
        type: 'Feature',
        id: 'point-feature',
        geometry: { type: 'Point', coordinates: [15, 15] },
        properties: { category: 'navaid' },
      },
    ])
    const hits = idx.featuresContainingPoint([15, 15])
    expect(hits.find(f => f.id === 'point-feature')).toBeUndefined()
  })
})
