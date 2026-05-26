import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import {
  asSourceId,
  type DatasetSource,
  type FetchCache,
  type GeoJsonGeometry,
  type NormalizedFeature,
  type RawBytes,
  type SourceId,
} from '../types.ts'
import { buildCacheEntry, conditionalGetHeaders } from '../fetch-cache.ts'
import { normaliseVerticalLimit, type RawVerticalLimit, type VerticalReference } from './vertical-limits.ts'
import type { AirspaceFeatureProperties } from '../airspace-schema.ts'

// OpenAIP V2 airspace source.
// REST: https://api.core.openaip.net/api/airspaces
// Auth: x-openaip-api-key header
// Pagination: page + limit query params
// Conditional GET: server returns etag; client sends If-None-Match.

const OPENAIP_BASE_URL = 'https://api.core.openaip.net'
const AIRSPACES_PATH = '/api/airspaces'
const DEFAULT_LIMIT = 1000
const MAX_PAGES = 50
const MAX_RETRIES = 5
const PAGE_DELIM = '\n--openaip-page-delim--\n'

// OpenAIP V2 `type` is a numeric code. Mapping derived empirically from the
// live API plus published documentation. Unknown codes fall back to
// `unknown-<n>` so coverage gaps stay visible without crashing.
const TYPE_CODE_TO_CATEGORY: Readonly<Record<number, string>> = {
  0: 'other',
  1: 'restricted',
  2: 'danger',
  3: 'prohibited',
  4: 'ctr',
  5: 'tmz',
  6: 'rmz',
  7: 'tma',
  8: 'tra',
  9: 'tsa',
  10: 'fir',
  11: 'uir',
  12: 'adiz',
  13: 'atz',
  14: 'matz',
  // OCA (Oceanic Control Area) — semantically a FIR over open ocean. Bodø OCA
  // is Norway's only FIR-equivalent entry in the live V2 API.
  15: 'fir',
  16: 'mtr',
  17: 'alert',
  18: 'warning',
  19: 'protected',
  20: 'htz',
  21: 'training',
  22: 'trp',
  23: 'tiz',
  24: 'tia',
  25: 'mta',
  26: 'cta',
  27: 'sector',
  28: 'training',
  29: 'overflight_restriction',
  30: 'mrt',
  31: 'tfr',
  32: 'ada',
  33: 'sua',
}

const ICAO_CLASS_CODE_TO_LETTER: Readonly<Record<number, 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'>> = {
  0: 'A', 1: 'B', 2: 'C', 3: 'D', 4: 'E', 5: 'F', 6: 'G',
}

const UNIT_CODE_TO_STRING: Readonly<Record<number, 'M' | 'FT' | 'FL'>> = {
  0: 'M', 1: 'FT', 6: 'FL',
}

const REFERENCE_DATUM_CODE_TO_STRING: Readonly<Record<number, 'GND' | 'MSL' | 'STD'>> = {
  0: 'GND', 1: 'MSL', 2: 'STD',
}

const verticalLimitJsonSchema = z.object({
  value: z.number().nullable(),
  unit: z.number().int().nullable(),
  referenceDatum: z.number().int().nullable(),
})

const frequencyEntrySchema = z.object({
  value: z.string(),
  unit: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  primary: z.boolean().optional(),
})

const positionTupleSchema = z.tuple([z.number(), z.number()]).or(z.tuple([z.number(), z.number(), z.number()]))
const ringSchema = z.array(positionTupleSchema)
const polygonCoordsSchema = z.array(ringSchema)
const multiPolygonCoordsSchema = z.array(polygonCoordsSchema)

// Live V2 field names: `upperLimit` / `lowerLimit` (not `upperCeiling` /
// `lowerCeiling`). `type` / `icaoClass` / `activity` are numeric codes.
// `byNotam` is the activation flag. Frequencies are a typed array.
const apiAirspaceFeatureSchema = z.object({
  _id: z.string().optional(),
  name: z.string().min(1),
  type: z.number().int(),
  icaoClass: z.number().int().optional(),
  activity: z.number().int().optional(),
  upperLimit: verticalLimitJsonSchema,
  lowerLimit: verticalLimitJsonSchema,
  byNotam: z.boolean().optional(),
  onDemand: z.boolean().optional(),
  onRequest: z.boolean().optional(),
  frequencies: z.array(frequencyEntrySchema).optional(),
  remarks: z.string().optional(),
  country: z.string().optional(),
  geometry: z.discriminatedUnion('type', [
    z.object({ type: z.literal('Polygon'), coordinates: polygonCoordsSchema }),
    z.object({ type: z.literal('MultiPolygon'), coordinates: multiPolygonCoordsSchema }),
  ]),
})

const apiPageSchema = z.object({
  items: z.array(z.unknown()),
  totalCount: z.number().optional(),
  totalPages: z.number().optional(),
  page: z.number().optional(),
  limit: z.number().optional(),
})

export type HttpFetch = (url: string, init?: { readonly method?: string; readonly headers?: Record<string, string> }) => Promise<Response>

export interface OpenAipSourceConfig {
  readonly id: string
  readonly apiKey: string
  readonly country: string
  readonly bbox?: readonly [number, number, number, number]
  readonly limit?: number
  readonly fetchFn?: HttpFetch
  readonly clock?: () => Date
  /** Test seam: sleep override for backoff. Default uses setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>
}

interface FetchedPage {
  readonly status: number
  readonly body: string
  readonly etag: string | null
  readonly lastModified: string | null
  readonly fromCache: boolean
  readonly retryAfterSec: number | null
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const parseRetryAfter = (header: string | null): number | null => {
  if (!header) return null
  const numeric = Number(header)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric
  const dateMs = Date.parse(header)
  if (!Number.isFinite(dateMs)) return null
  const deltaSec = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000))
  return deltaSec
}

const exponentialBackoffMs = (attempt: number): number => {
  // attempt = 1..N
  const base = 2000
  const max = 60000
  return Math.min(max, base * 2 ** (attempt - 1))
}

const buildAirspaceUrl = (config: OpenAipSourceConfig, page: number, limit: number): string => {
  const url = new URL(AIRSPACES_PATH, OPENAIP_BASE_URL)
  url.searchParams.set('country', config.country)
  url.searchParams.set('page', String(page))
  url.searchParams.set('limit', String(limit))
  if (config.bbox) url.searchParams.set('bbox', config.bbox.join(','))
  return url.toString()
}

const pageSourceId = (baseId: string, page: number): SourceId => asSourceId(`${baseId}:p${page}`)

const fetchPageOnce = async (
  config: OpenAipSourceConfig,
  url: string,
  cache: FetchCache,
  pageId: SourceId,
): Promise<FetchedPage> => {
  const fetchFn: HttpFetch = config.fetchFn ?? ((url, init) => globalThis.fetch(url, init))
  const cached = await cache.read(pageId)
  const headers: Record<string, string> = {
    'x-openaip-api-key': config.apiKey,
    'accept': 'application/json',
    ...conditionalGetHeaders(cached),
  }
  const response = await fetchFn(url, { method: 'GET', headers })
  const status = response.status
  if (status === 304) {
    if (!cached) throw new Error(`openaip: server returned 304 but no cached body exists for ${url}`)
    const cachedBody = await readFile(cached.path, 'utf8')
    return {
      status: 200,
      body: cachedBody,
      etag: cached.etag,
      lastModified: cached.lastModified,
      fromCache: true,
      retryAfterSec: null,
    }
  }
  const body = await response.text()
  if (status === 429) {
    return {
      status,
      body,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      fromCache: false,
      retryAfterSec: parseRetryAfter(response.headers.get('retry-after')),
    }
  }
  if (status < 200 || status >= 300) {
    const trimmed = body.length > 300 ? `${body.slice(0, 300)}…` : body
    throw new Error(`openaip: HTTP ${status} for ${url} — ${trimmed}`)
  }
  return {
    status,
    body,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    fromCache: false,
    retryAfterSec: null,
  }
}

const fetchPageWithBackoff = async (
  config: OpenAipSourceConfig,
  url: string,
  cache: FetchCache,
  pageId: SourceId,
): Promise<FetchedPage> => {
  const sleep = config.sleep ?? defaultSleep
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const page = await fetchPageOnce(config, url, cache, pageId)
    if (page.status !== 429) return page
    const waitMs = page.retryAfterSec !== null ? page.retryAfterSec * 1000 : exponentialBackoffMs(attempt)
    await sleep(waitMs)
  }
  throw new Error(`openaip: rate-limited beyond ${MAX_RETRIES} retries for ${url}`)
}

const encoder = new TextEncoder()

const persistPage = async (cache: FetchCache, pageId: SourceId, page: FetchedPage): Promise<void> => {
  if (page.fromCache) return
  const bytes: RawBytes = encoder.encode(page.body)
  const entry = buildCacheEntry({
    sourceId: pageId,
    body: bytes,
    etag: page.etag,
    lastModified: page.lastModified,
  })
  await cache.write(entry, bytes)
}

const itemsInPage = (body: string): { readonly items: unknown[]; readonly returned: number } => {
  const parsed = apiPageSchema.parse(JSON.parse(body))
  return { items: parsed.items, returned: parsed.items.length }
}

type ApiVerticalLimit = { readonly value: number | null; readonly unit: number | null; readonly referenceDatum: number | null }

const codedToRaw = (limit: ApiVerticalLimit): RawVerticalLimit => ({
  value: limit.value,
  unit: limit.unit !== null ? (UNIT_CODE_TO_STRING[limit.unit] ?? null) : null,
  referenceDatum: limit.referenceDatum !== null ? (REFERENCE_DATUM_CODE_TO_STRING[limit.referenceDatum] ?? null) : null,
})

const verticalReferenceFrom = (raw: RawVerticalLimit): VerticalReference => normaliseVerticalLimit(raw).reference

interface FrequencyLike { readonly value: string; readonly primary?: boolean | undefined }
const pickPrimaryFrequencyMhz = (
  frequencies: ReadonlyArray<FrequencyLike> | undefined,
): number | null => {
  if (!frequencies || frequencies.length === 0) return null
  const candidate = frequencies.find(f => f.primary) ?? frequencies[0]
  if (!candidate) return null
  const v = Number(candidate.value)
  return Number.isFinite(v) ? v : null
}

const normaliseFeature = (
  raw: unknown,
  country: string,
  warnings: string[],
): NormalizedFeature | null => {
  const parsed = apiAirspaceFeatureSchema.safeParse(raw)
  if (!parsed.success) {
    warnings.push(`feature rejected: ${parsed.error.message.slice(0, 200)}`)
    return null
  }
  const data = parsed.data
  const lowerRaw = codedToRaw(data.lowerLimit)
  const upperRaw = codedToRaw(data.upperLimit)
  let lower
  let upper
  try {
    lower = normaliseVerticalLimit(lowerRaw)
    upper = normaliseVerticalLimit(upperRaw)
  } catch (err) {
    warnings.push(`vertical-limit conversion failed for ${data.name}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  const mapped = TYPE_CODE_TO_CATEGORY[data.type]
  let category: string
  if (mapped) {
    category = mapped
  } else {
    warnings.push(`unknown OpenAIP type code ${data.type} for "${data.name}"; categorising as unknown-${data.type}`)
    category = `unknown-${data.type}`
  }
  const classLetter = data.icaoClass !== undefined
    ? (ICAO_CLASS_CODE_TO_LETTER[data.icaoClass] ?? null)
    : null
  const frequencyMhz = pickPrimaryFrequencyMhz(data.frequencies)
  const callsign = data.frequencies?.find(f => f.name && f.name.length > 0)?.name ?? null
  const properties: AirspaceFeatureProperties = {
    name: data.name,
    category,
    classLetter,
    floorM: lower.metres,
    ceilingM: upper.metres,
    floorRef: verticalReferenceFrom(lowerRaw),
    ceilingRef: verticalReferenceFrom(upperRaw),
    floorLabel: lower.label,
    ceilingLabel: upper.label,
    activity: data.activity !== undefined ? String(data.activity) : null,
    activatedByNotam: data.byNotam ?? false,
    frequencyMhz,
    callsign,
    remarks: data.remarks ?? null,
    source: 'openaip',
    sourceExternalId: data._id ?? null,
    country: (data.country ?? country).toUpperCase(),
  }
  return {
    type: 'Feature',
    ...(data._id ? { id: data._id } : {}),
    geometry: data.geometry as GeoJsonGeometry,
    properties,
  }
}

const fetchAllPages = async (config: OpenAipSourceConfig, cache: FetchCache): Promise<string> => {
  const limit = config.limit ?? DEFAULT_LIMIT
  const bodies: string[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildAirspaceUrl(config, page, limit)
    const pageId = pageSourceId(config.id, page)
    const fetched = await fetchPageWithBackoff(config, url, cache, pageId)
    await persistPage(cache, pageId, fetched)
    bodies.push(fetched.body)
    const { returned } = itemsInPage(fetched.body)
    if (returned < limit) break
    if (page === MAX_PAGES) {
      throw new Error(`openaip: pagination did not terminate after ${MAX_PAGES} pages (${limit} per page)`)
    }
  }
  return bodies.join(PAGE_DELIM)
}

const parseAllPages = async (
  config: Pick<OpenAipSourceConfig, 'country'>,
  combined: string,
): Promise<ReadonlyArray<NormalizedFeature>> => {
  const features: NormalizedFeature[] = []
  const warnings: string[] = []
  for (const body of combined.split(PAGE_DELIM)) {
    if (body.length === 0) continue
    const { items } = itemsInPage(body)
    for (const item of items) {
      const feature = normaliseFeature(item, config.country, warnings)
      if (feature) features.push(feature)
    }
  }
  // Warnings from the parser are intentionally discarded for V1; the pipeline's
  // schema validation surfaces per-feature failures in audit-report.json, and
  // unknown OpenAIP "type" values still appear under their lowercase category
  // in categoryCounts so coverage gaps are visible. A richer warning channel
  // can be added when a real caller needs it.
  return features
}

export const openAipAirspaceSource = (config: OpenAipSourceConfig): DatasetSource => {
  if (!config.apiKey) throw new Error('openAipAirspaceSource: apiKey is required (set OPENAIP_API_KEY)')
  if (!/^[A-Z]{2}$/.test(config.country)) throw new Error(`openAipAirspaceSource: country must be ISO-3166-1 alpha-2, got "${config.country}"`)
  return {
    kind: 'remote',
    id: asSourceId(config.id),
    fetch: async (cache) => {
      const combined = await fetchAllPages(config, cache)
      return encoder.encode(combined)
    },
    parse: async (raw) => {
      const decoded = new TextDecoder().decode(raw)
      return parseAllPages(config, decoded)
    },
  }
}

// Exposed for unit tests only.
export const __internals = {
  buildAirspaceUrl,
  exponentialBackoffMs,
  parseRetryAfter,
  normaliseFeature,
  TYPE_CODE_TO_CATEGORY,
  ICAO_CLASS_CODE_TO_LETTER,
  UNIT_CODE_TO_STRING,
  REFERENCE_DATUM_CODE_TO_STRING,
}
