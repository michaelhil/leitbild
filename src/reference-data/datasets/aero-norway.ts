import { z } from 'zod'
import { join } from 'node:path'
import { airspaceFeatureSchema } from '../airspace-schema.ts'
import { airportFeatureSchema } from '../airport-schema.ts'
import { manualOverlaySchema } from '../manual-overlay-schema.ts'
import { ccByNcSa40, nlod20, repoOwned } from '../licences.ts'
import { manualSource } from '../sources/manual.ts'
import { avinorAirportsSource } from '../sources/avinor-airports.ts'
import { openAipAirspaceSource } from '../sources/openaip.ts'
import type { HttpFetch } from '../sources/openaip.ts'
import {
  asDatasetId,
  type DatasetConfig,
  type NormalizedFeature,
  type TilebuildConfig,
} from '../types.ts'

// aero-norway: Norwegian airspace polygons (OpenAIP) + Avinor airport points (GeoNorge)
// + repo-tracked manual overlays (Halden exclusion zone today, future scenario-specific
// geometry). See ADRs 0019, 0020, 0021.

export const aeroNorwayDatasetId = asDatasetId('aero-norway')

export const aeroFeatureSchema = z.union([
  airspaceFeatureSchema,
  airportFeatureSchema,
  manualOverlaySchema,
])

export type AeroFeatureProperties = z.infer<typeof aeroFeatureSchema>

export interface AeroNorwayThresholds {
  readonly fir: number
  readonly tma: number
  readonly ctr: number
  readonly airport: number
}

// Production audit thresholds for ENOR. OpenAIP carries 1 FIR-equivalent
// (Bodø OCA on type=15) for Norway as of AIRAC 2604; we treat OCA as `fir` in
// the parser. TMA / CTR counts reflect the live data (46 / 8 respectively).
// Airport count comes from the Avinor WFS.
export const aeroNorwayProductionThresholds: AeroNorwayThresholds = {
  fir: 1,
  tma: 10,
  ctr: 8,
  airport: 40,
}

const KNOWN_CATEGORIES: ReadonlyArray<string> = [
  'fir', 'uir', 'cta', 'tma', 'ctr', 'atz',
  'restricted', 'prohibited', 'danger', 'warning',
  'rmz', 'tmz', 'matz', 'training',
  'airport', 'exclusion', 'reference',
]

export const aeroTilebuild: TilebuildConfig = {
  outputLayer: 'aero',
  globalMinZoom: 4,
  globalMaxZoom: 14,
  categories: [
    { category: 'fir',         minZoom: 4,  maxZoom: 12 },
    { category: 'uir',         minZoom: 4,  maxZoom: 12 },
    { category: 'cta',         minZoom: 6,  maxZoom: 14 },
    { category: 'tma',         minZoom: 6,  maxZoom: 14 },
    { category: 'ctr',         minZoom: 8,  maxZoom: 14 },
    { category: 'atz',         minZoom: 10, maxZoom: 14 },
    { category: 'restricted',  minZoom: 5,  maxZoom: 14 },
    { category: 'prohibited',  minZoom: 5,  maxZoom: 14 },
    { category: 'danger',      minZoom: 5,  maxZoom: 14 },
    { category: 'warning',     minZoom: 5,  maxZoom: 14 },
    { category: 'rmz',         minZoom: 7,  maxZoom: 14 },
    { category: 'tmz',         minZoom: 7,  maxZoom: 14 },
    { category: 'matz',        minZoom: 7,  maxZoom: 14 },
    { category: 'training',    minZoom: 7,  maxZoom: 14 },
    { category: 'airport',     minZoom: 6,  maxZoom: 14 },
    { category: 'exclusion',   minZoom: 5,  maxZoom: 14 },
    { category: 'reference',   minZoom: 7,  maxZoom: 14 },
  ],
}

const sourceOf = (feature: NormalizedFeature): string => {
  const source = feature.properties.source
  return typeof source === 'string' ? source : ''
}

const categoryOf = (feature: NormalizedFeature): string => {
  const category = feature.properties.category
  return typeof category === 'string' && category.length > 0 ? category : 'unknown'
}

export const aeroFeatureToCategory = (feature: NormalizedFeature): string => {
  const source = sourceOf(feature)
  if (source.startsWith('geonorge:')) return 'airport'
  if (source === 'manual') return categoryOf(feature)
  if (source === 'openaip') return categoryOf(feature)
  return 'unknown'
}

const countByCategory = (features: ReadonlyArray<NormalizedFeature>): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const feature of features) {
    const category = aeroFeatureToCategory(feature)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return counts
}

const failsThreshold = (counts: Map<string, number>, key: keyof AeroNorwayThresholds, thresholds: AeroNorwayThresholds): string | null => {
  const count = counts.get(key) ?? 0
  return count < thresholds[key]
    ? `category "${key}" count ${count} is below threshold ${thresholds[key]}`
    : null
}

const unknownCategoryWarnings = (counts: Map<string, number>): string[] => {
  const warnings: string[] = []
  for (const [category, count] of counts) {
    if (KNOWN_CATEGORIES.includes(category)) continue
    warnings.push(`unexpected category "${category}" with ${count} feature(s); not declared in tilebuild config`)
  }
  return warnings
}

export interface AeroNorwayDatasetConfig {
  readonly openaipApiKey: string
  readonly openaipLimit?: number
  readonly openaipFetchFn?: HttpFetch
  readonly avinorFetchFn?: HttpFetch
  readonly manualOverlayPath?: string
  readonly thresholds?: AeroNorwayThresholds
}

const resolveManualPath = (configPath: string | undefined): string =>
  configPath ?? join(process.cwd(), 'data', 'reference', 'manual', 'halden-exclusion-zone.geojson')

export const createAeroNorwayDataset = (config: AeroNorwayDatasetConfig): DatasetConfig => {
  const thresholds = config.thresholds ?? aeroNorwayProductionThresholds
  const manualPath = resolveManualPath(config.manualOverlayPath)

  const airspaceSource = openAipAirspaceSource({
    id: 'openaip:airspaces:NO',
    apiKey: config.openaipApiKey,
    country: 'NO',
    ...(config.openaipLimit !== undefined ? { limit: config.openaipLimit } : {}),
    ...(config.openaipFetchFn ? { fetchFn: config.openaipFetchFn } : {}),
  })

  const airportSource = avinorAirportsSource({
    ...(config.avinorFetchFn ? { fetchFn: config.avinorFetchFn } : {}),
  })

  const overlaySource = manualSource({
    id: 'manual:halden-exclusion-zone',
    path: manualPath,
  })

  const audit = (features: ReadonlyArray<NormalizedFeature>): void => {
    const counts = countByCategory(features)
    const errors: string[] = []
    for (const key of ['fir', 'tma', 'ctr', 'airport'] as const) {
      const e = failsThreshold(counts, key, thresholds)
      if (e) errors.push(e)
    }
    if (errors.length > 0) {
      throw new Error(`aero-norway audit thresholds not met: ${errors.join('; ')}`)
    }
    // Unknown categories are warnings, not failures. The pipeline currently writes
    // audit-report.json only with the error/warning fields it knows; future work can
    // surface unknown-category warnings explicitly when a warnings channel exists.
    void unknownCategoryWarnings(counts)
  }

  return {
    id: aeroNorwayDatasetId,
    schemaVersion: 1,
    featureSchema: aeroFeatureSchema,
    sources: [airspaceSource, airportSource, overlaySource],
    tilebuild: aeroTilebuild,
    licences: [ccByNcSa40, nlod20, repoOwned],
    audit,
    featureToCategory: aeroFeatureToCategory,
  }
}

export const __internals = {
  countByCategory,
  unknownCategoryWarnings,
  KNOWN_CATEGORIES,
}
