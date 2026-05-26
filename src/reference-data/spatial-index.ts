import { readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { geometryBbox, pointInBbox, pointInPolygon } from './point-in-polygon.ts'
import type { DatasetId, GeoJsonPosition, NormalizedFeature, QueryOpts } from './types.ts'

// Server-side reference-data spatial index.
// Reads the sidecar GeoJSON written next to the PMTiles archive (see ADR 0021),
// then answers featuresContainingPoint queries by bbox pre-filter + polygon PIP.
// Single method by design; additional spatial predicates are added when a real
// caller asks for them.
//
// The index is lazy: dataset features are loaded on first query, kept in a module
// cache, and reloaded automatically when the dataset's release symlink target changes.

export interface SpatialIndex {
  readonly featuresContainingPoint: (point: GeoJsonPosition, opts?: QueryOpts) => ReadonlyArray<NormalizedFeature>
}

interface IndexedFeature {
  readonly feature: NormalizedFeature
  readonly bbox: readonly [number, number, number, number]
  readonly category: string | null
  readonly floorM: number | null
  readonly ceilingM: number | null
}

interface CachedIndex {
  readonly entries: ReadonlyArray<IndexedFeature>
  readonly closeWatcher: () => void
}

const moduleCache = new Map<DatasetId, CachedIndex>()

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const indexFeatures = (features: ReadonlyArray<NormalizedFeature>): ReadonlyArray<IndexedFeature> => {
  const entries: IndexedFeature[] = []
  for (const feature of features) {
    const bbox = geometryBbox(feature.geometry)
    if (!bbox) continue
    entries.push({
      feature,
      bbox,
      category: stringOrNull(feature.properties.category),
      floorM: numberOrNull(feature.properties.floorM),
      ceilingM: numberOrNull(feature.properties.ceilingM),
    })
  }
  return entries
}

const altitudeMatches = (altitudeM: number | undefined, entry: IndexedFeature): boolean => {
  if (altitudeM === undefined) return true
  if (entry.floorM !== null && altitudeM < entry.floorM) return false
  if (entry.ceilingM !== null && altitudeM > entry.ceilingM) return false
  return true
}

const categoryMatches = (allowed: ReadonlyArray<string> | undefined, entry: IndexedFeature): boolean => {
  if (!allowed || allowed.length === 0) return true
  if (entry.category === null) return false
  return allowed.includes(entry.category)
}

/**
 * Construct a SpatialIndex from an in-memory feature collection.
 * Used by tests and by callers that already have the features in hand.
 */
export const spatialIndexFromFeatures = (features: ReadonlyArray<NormalizedFeature>): SpatialIndex => {
  const entries = indexFeatures(features)
  return {
    featuresContainingPoint: (point, opts) => {
      const results: NormalizedFeature[] = []
      for (const entry of entries) {
        if (!pointInBbox(point, entry.bbox)) continue
        if (!categoryMatches(opts?.categories, entry)) continue
        if (!altitudeMatches(opts?.altitudeM, entry)) continue
        if (entry.feature.geometry.type !== 'Polygon' && entry.feature.geometry.type !== 'MultiPolygon') continue
        if (pointInPolygon(point, entry.feature.geometry)) results.push(entry.feature)
      }
      return results
    },
  }
}

const sidecarPathFor = (releaseRoot: string, datasetId: DatasetId): string =>
  join(releaseRoot, datasetId, 'current', `${datasetId}.features.geojson`)

const loadSidecar = async (path: string): Promise<ReadonlyArray<NormalizedFeature>> => {
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as { type: string; features?: ReadonlyArray<NormalizedFeature> }
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(`sidecar at ${path} is not a FeatureCollection`)
  }
  return parsed.features
}

const startWatcher = (releaseRoot: string, datasetId: DatasetId): (() => void) => {
  const watchDir = dirname(sidecarPathFor(releaseRoot, datasetId))
  // Watch the parent directory; current is a symlink and direct watch behaviour
  // varies between macOS and Linux. The release-directory rename surfaces as a
  // 'rename' event on the parent.
  const watcher = watch(dirname(watchDir), { persistent: false }, () => {
    moduleCache.delete(datasetId)
  })
  return () => watcher.close()
}

export const referenceIndex = async (datasetId: DatasetId, releaseRoot: string): Promise<SpatialIndex> => {
  const cached = moduleCache.get(datasetId)
  if (cached) {
    return {
      featuresContainingPoint: (point, opts) => spatialIndexFromCache(cached, point, opts),
    }
  }
  const features = await loadSidecar(sidecarPathFor(releaseRoot, datasetId))
  const entries = indexFeatures(features)
  const closeWatcher = startWatcher(releaseRoot, datasetId)
  const fresh: CachedIndex = { entries, closeWatcher }
  moduleCache.set(datasetId, fresh)
  return {
    featuresContainingPoint: (point, opts) => spatialIndexFromCache(fresh, point, opts),
  }
}

const spatialIndexFromCache = (cache: CachedIndex, point: GeoJsonPosition, opts?: QueryOpts): ReadonlyArray<NormalizedFeature> => {
  const results: NormalizedFeature[] = []
  for (const entry of cache.entries) {
    if (!pointInBbox(point, entry.bbox)) continue
    if (!categoryMatches(opts?.categories, entry)) continue
    if (!altitudeMatches(opts?.altitudeM, entry)) continue
    if (entry.feature.geometry.type !== 'Polygon' && entry.feature.geometry.type !== 'MultiPolygon') continue
    if (pointInPolygon(point, entry.feature.geometry)) results.push(entry.feature)
  }
  return results
}

/**
 * Drop all cached indices. Test-only.
 */
export const clearSpatialIndexCacheForTests = (): void => {
  for (const entry of moduleCache.values()) entry.closeWatcher()
  moduleCache.clear()
}
