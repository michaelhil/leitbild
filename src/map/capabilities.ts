import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

// Map Capability Manifest v2.
// Top-level shape:
//   { schemaVersion: 2, tilesets: [BaseTileset, ...ReferenceTileset[]] }
// The first element is the OSM base tileset (kind: 'base'); subsequent entries
// are reference datasets discovered at runtime from /opt/leitbild/reference/releases.
// See ADR 0019 (reference data pipeline) and docs/map-capability-manifest.md.

export const mapTilesetId = 'leitbild-osm-norway'
export const mapManifestSchemaVersion = 2 as const
export const mapManifestSchemaVersionLiteral = z.literal(2)

export const mapCapabilityFieldAvailabilitySchema = z.enum(['required', 'optional'])
export type MapCapabilityFieldAvailability = z.infer<typeof mapCapabilityFieldAvailabilitySchema>

export const mapCapabilityFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  availability: mapCapabilityFieldAvailabilitySchema,
  values: z.array(z.string().min(1)).optional(),
  description: z.string().min(1),
})
export type MapCapabilityField = z.infer<typeof mapCapabilityFieldSchema>

export const mapCapabilityLayerSchema = z.object({
  id: z.string().min(1),
  sourceLayer: z.string().min(1),
  geometry: z.array(z.enum(['point', 'line', 'polygon'])).min(1),
  category: z.enum(['road_semantics', 'operational_poi', 'risk_context', 'mobility_constraint', 'base_context']),
  intendedUse: z.string().min(1),
  fields: z.array(mapCapabilityFieldSchema),
})
export type MapCapabilityLayer = z.infer<typeof mapCapabilityLayerSchema>

// --- Base (OSM) tileset entry ---------------------------------------------

export const baseTilesetSchema = z.object({
  kind: z.literal('base'),
  id: z.literal(mapTilesetId),
  schemaVersion: z.literal(1),
  region: z.object({
    id: z.literal('norway'),
    source: z.literal('geofabrik'),
    sourceUrl: z.string().url(),
  }),
  artifact: z.object({
    format: z.literal('pmtiles'),
    tileEncoding: z.literal('mvt'),
    currentTileUrl: z.literal('/map/tiles/current.pmtiles'),
    styleUrl: z.literal('/map/style.json'),
    glyphsUrl: z.literal('/map/fonts/{fontstack}/{range}.pbf'),
  }),
  schema: z.object({
    name: z.literal('openmaptiles-compatible-leitbild-v1'),
    generatedBy: z.literal('planetiler-openmaptiles'),
    evolution: z.literal('breaking changes increment schemaVersion; no backward compatibility is preserved'),
  }),
  layers: z.array(mapCapabilityLayerSchema).min(1),
})
export type BaseTileset = z.infer<typeof baseTilesetSchema>

// --- Reference tileset entry (per-dataset manifest fragments on disk) ------

const tilesetSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['manual', 'remote']),
})

const tilesetLicenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string(),
  attribution: z.string().min(1),
  commercialUseAllowed: z.boolean(),
  redistributionAllowed: z.boolean(),
  shareAlike: z.boolean(),
})

const tilesetCategorySchema = z.object({
  category: z.string().min(1),
  minZoom: z.number().int().min(0).max(24),
  maxZoom: z.number().int().min(0).max(24),
  featureCount: z.number().int().min(0),
})

// Matches the per-dataset manifest fragment shape from manifest-writer.ts
// (Phase A.1). The on-disk field name is `datasetId`; we layer `kind:
// 'reference'` on top when assembling the unified manifest.
export const referenceTilesetSchema = z.object({
  kind: z.literal('reference'),
  datasetId: z.string().min(1),
  schemaVersion: z.literal(1),
  builtAt: z.string().min(1),
  buildId: z.string().min(1),
  airac: z.string().min(1).optional(),
  artifact: z.object({
    pmtilesPath: z.string().min(1),
    sidecarGeoJsonPath: z.string().min(1),
    outputLayer: z.string().min(1),
  }),
  categories: z.array(tilesetCategorySchema),
  sources: z.array(tilesetSourceSchema).min(1),
  licences: z.array(tilesetLicenceSchema).min(1),
})
export type ReferenceTileset = z.infer<typeof referenceTilesetSchema>

// --- Discriminated union + top-level manifest -----------------------------

export const tilesetEntrySchema = z.discriminatedUnion('kind', [
  baseTilesetSchema,
  referenceTilesetSchema,
])
export type TilesetEntry = z.infer<typeof tilesetEntrySchema>

export const mapCapabilityManifestSchema = z.object({
  schemaVersion: mapManifestSchemaVersionLiteral,
  tilesets: z.array(tilesetEntrySchema).min(1),
})
export type MapCapabilityManifest = z.infer<typeof mapCapabilityManifestSchema>

// --- Base tileset payload + sync factory (for style.ts) -------------------

const roadClassValues = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'minor', 'service', 'track', 'path', 'rail', 'ferry',
]

const poiClassValues = [
  'hospital', 'fire_station', 'police', 'doctors', 'pharmacy',
  'helipad', 'airport', 'port', 'fuel', 'charging_station',
]

const baseLayers: ReadonlyArray<MapCapabilityLayer> = [
  {
    id: 'transportation', sourceLayer: 'transportation', geometry: ['line', 'polygon'],
    category: 'road_semantics',
    intendedUse: 'Road hierarchy, route context, surface-level mobility interpretation, and control-center visual road emphasis.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', values: roadClassValues, description: 'Normalized road or transportation class.' },
      { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific OSM-derived transportation subtype when emitted by the profile.' },
      { name: 'brunnel', type: 'string', availability: 'optional', values: ['bridge', 'tunnel', 'ford'], description: 'Bridge/tunnel/ford context where the profile emits it.' },
      { name: 'oneway', type: 'boolean', availability: 'optional', description: 'One-way direction hint where available.' },
      { name: 'ramp', type: 'boolean', availability: 'optional', description: 'Ramp hint where available.' },
      { name: 'service', type: 'string', availability: 'optional', description: 'Service road subtype where available.' },
      { name: 'access', type: 'string', availability: 'optional', description: 'Access restriction hint where available.' },
      { name: 'maxspeed', type: 'number', availability: 'optional', description: 'Speed-limit hint where available; routing engines remain authoritative for routing.' },
    ],
  },
  {
    id: 'transportation_name', sourceLayer: 'transportation_name', geometry: ['line'],
    category: 'road_semantics', intendedUse: 'Road labeling and operator orientation.',
    fields: [
      { name: 'name', type: 'string', availability: 'optional', description: 'Displayed road name.' },
      { name: 'class', type: 'string', availability: 'optional', values: roadClassValues, description: 'Road class associated with the label feature.' },
    ],
  },
  {
    id: 'poi', sourceLayer: 'poi', geometry: ['point'],
    category: 'operational_poi',
    intendedUse: 'Static map context for emergency, transport, and infrastructure POIs. These are not canonical Leitbild operational objects.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', values: poiClassValues, description: 'Normalized point-of-interest class.' },
      { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific OSM-derived POI subtype.' },
      { name: 'name', type: 'string', availability: 'optional', description: 'POI label.' },
    ],
  },
  {
    id: 'landuse', sourceLayer: 'landuse', geometry: ['polygon'],
    category: 'risk_context',
    intendedUse: 'Urban, industrial, commercial, residential, and other land-use context useful for scenarios and risk interpretation.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', description: 'Normalized land-use class.' },
    ],
  },
  {
    id: 'landcover', sourceLayer: 'landcover', geometry: ['polygon'],
    category: 'risk_context',
    intendedUse: 'Natural context such as wood, grass, wetland, rock, or sand for scenario interpretation and map readability.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', values: ['wood', 'grass', 'wetland', 'rock', 'sand', 'farmland', 'ice'], description: 'Normalized land-cover class.' },
      { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific land-cover subtype.' },
    ],
  },
  {
    id: 'water', sourceLayer: 'water', geometry: ['polygon'],
    category: 'risk_context',
    intendedUse: 'Water polygons for situational awareness, route context, and scenario constraints.',
    fields: [
      { name: 'class', type: 'string', availability: 'optional', description: 'Water class where available.' },
    ],
  },
  {
    id: 'waterway', sourceLayer: 'waterway', geometry: ['line'],
    category: 'risk_context',
    intendedUse: 'Rivers, streams, canals, and drainage lines as scenario context.',
    fields: [
      { name: 'class', type: 'string', availability: 'optional', description: 'Waterway class where available.' },
    ],
  },
  {
    id: 'building', sourceLayer: 'building', geometry: ['polygon'],
    category: 'base_context',
    intendedUse: 'Building footprints for dense urban orientation and future 2.5D context.',
    fields: [
      { name: 'render_height', type: 'number', availability: 'optional', description: 'Approximate render height when emitted by the profile.' },
      { name: 'render_min_height', type: 'number', availability: 'optional', description: 'Approximate minimum render height when emitted by the profile.' },
    ],
  },
  {
    id: 'aeroway', sourceLayer: 'aeroway', geometry: ['line', 'polygon'],
    category: 'mobility_constraint',
    intendedUse: 'Airfield and runway context for helicopter, drone, aircraft, and emergency-response scenarios.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', description: 'Aeroway class.' },
    ],
  },
  {
    id: 'boundary', sourceLayer: 'boundary', geometry: ['line'],
    category: 'base_context',
    intendedUse: 'Administrative boundaries for jurisdiction and scenario region context.',
    fields: [
      { name: 'admin_level', type: 'number', availability: 'optional', description: 'OSM administrative level where available.' },
      { name: 'maritime', type: 'boolean', availability: 'optional', description: 'Maritime boundary hint where available.' },
    ],
  },
]

export const createBaseTileset = (): BaseTileset => baseTilesetSchema.parse({
  kind: 'base',
  id: mapTilesetId,
  schemaVersion: 1,
  region: {
    id: 'norway',
    source: 'geofabrik',
    sourceUrl: 'https://download.geofabrik.de/europe/norway-latest.osm.pbf',
  },
  artifact: {
    format: 'pmtiles',
    tileEncoding: 'mvt',
    currentTileUrl: '/map/tiles/current.pmtiles',
    styleUrl: '/map/style.json',
    glyphsUrl: '/map/fonts/{fontstack}/{range}.pbf',
  },
  schema: {
    name: 'openmaptiles-compatible-leitbild-v1',
    generatedBy: 'planetiler-openmaptiles',
    evolution: 'breaking changes increment schemaVersion; no backward compatibility is preserved',
  },
  layers: baseLayers,
})

/**
 * Synchronous manifest with the base OSM tileset only. Used by style.ts (which
 * is synchronous and doesn't need reference tilesets at construction time) and
 * by tests. The async loadMapCapabilityManifest() variant additionally reads
 * promoted reference datasets from disk.
 */
export const createMapCapabilityManifest = (): MapCapabilityManifest =>
  mapCapabilityManifestSchema.parse({
    schemaVersion: mapManifestSchemaVersion,
    tilesets: [createBaseTileset()],
  })

// --- Async loader: base + on-disk reference manifests ---------------------

export interface LoadManifestConfig {
  readonly referenceRoot: string
}

export const referenceRootFromEnv = (): string =>
  resolve(process.env.LEITBILD_REFERENCE_ROOT ?? '/opt/leitbild/reference')

interface ManifestCacheEntry {
  readonly manifest: MapCapabilityManifest
  readonly stamps: ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>
}

let cache: ManifestCacheEntry | null = null

const readReferenceManifest = async (
  referenceRoot: string,
  datasetId: string,
): Promise<{ readonly tileset: ReferenceTileset | null; readonly mtimeMs: number | null }> => {
  const currentDir = join(referenceRoot, 'releases', datasetId, 'current')
  let mtimeMs: number | null = null
  try {
    const s = await stat(currentDir)
    mtimeMs = s.mtimeMs
  } catch {
    return { tileset: null, mtimeMs: null }
  }
  // Manifest file is `<datasetId>.manifest.json` per the pipeline writer.
  const manifestPath = join(currentDir, `${datasetId}.manifest.json`)
  try {
    const raw = await readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // The on-disk manifest is the per-dataset shape from manifest-writer.ts (no
    // top-level `kind`). We layer that on top of `kind: 'reference'`.
    const candidate = { kind: 'reference' as const, ...parsed }
    const tileset = referenceTilesetSchema.parse(candidate)
    return { tileset, mtimeMs }
  } catch (err) {
    console.warn(`map-capabilities: skipping reference dataset "${datasetId}" — ${err instanceof Error ? err.message : String(err)}`)
    return { tileset: null, mtimeMs }
  }
}

const listReferenceDatasetIds = async (referenceRoot: string): Promise<ReadonlyArray<string>> => {
  const releasesDir = join(referenceRoot, 'releases')
  try {
    const entries = await readdir(releasesDir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort()
  } catch {
    return []
  }
}

const stampsMatch = (a: ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>, b: ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || a[i]!.mtimeMs !== b[i]!.mtimeMs) return false
  }
  return true
}

const buildStamps = async (referenceRoot: string, datasetIds: ReadonlyArray<string>): Promise<ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>> => {
  const stamps: { readonly id: string; readonly mtimeMs: number }[] = []
  for (const id of datasetIds) {
    try {
      const s = await stat(join(referenceRoot, 'releases', id, 'current'))
      stamps.push({ id, mtimeMs: s.mtimeMs })
    } catch {
      // Skip; reader will handle missing.
    }
  }
  return stamps
}

/**
 * Asynchronously load the full manifest including reference tilesets discovered
 * on disk. Uses an in-process cache keyed by per-dataset symlink mtime so the
 * hot path (every /map/capabilities.json request) only does cheap stat calls
 * unless something actually changed.
 */
export const loadMapCapabilityManifest = async (
  config: LoadManifestConfig = { referenceRoot: referenceRootFromEnv() },
): Promise<MapCapabilityManifest> => {
  const datasetIds = await listReferenceDatasetIds(config.referenceRoot)
  const freshStamps = await buildStamps(config.referenceRoot, datasetIds)
  if (cache && stampsMatch(cache.stamps, freshStamps)) return cache.manifest

  const referenceTilesets: ReferenceTileset[] = []
  for (const id of datasetIds) {
    const { tileset } = await readReferenceManifest(config.referenceRoot, id)
    if (tileset) referenceTilesets.push(tileset)
  }
  const manifest = mapCapabilityManifestSchema.parse({
    schemaVersion: mapManifestSchemaVersion,
    tilesets: [createBaseTileset(), ...referenceTilesets],
  })
  cache = { manifest, stamps: freshStamps }
  return manifest
}

/** Test seam: drop the in-process manifest cache. */
export const __clearManifestCacheForTests = (): void => { cache = null }

// --- Helpers for consumers ------------------------------------------------

export const findBaseTileset = (manifest: MapCapabilityManifest): BaseTileset => {
  for (const t of manifest.tilesets) if (t.kind === 'base') return t
  throw new Error('map capability manifest contains no base tileset')
}

export const findReferenceTilesets = (manifest: MapCapabilityManifest): ReadonlyArray<ReferenceTileset> =>
  manifest.tilesets.filter((t): t is ReferenceTileset => t.kind === 'reference')
