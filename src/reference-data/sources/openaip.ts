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

// OpenAIP `type` enum → our canonical category.
const TYPE_TO_CATEGORY: Readonly<Record<string, string>> = {
  CTA: 'cta',
  TMA: 'tma',
  CTR: 'ctr',
  ATZ: 'atz',
  DANGER: 'danger',
  PROHIBITED: 'prohibited',
  RESTRICTED: 'restricted',
  WARNING: 'warning',
  RMZ: 'rmz',
  TMZ: 'tmz',
  MATZ: 'matz',
  GLIDING_SECTOR: 'training',
  AERIAL_SPORTING_RECREATIONAL: 'training',
  FIR: 'fir',
  UIR: 'uir',
}

const verticalLimitJsonSchema = z.object({
  value: z.number().nullable(),
  unit: z.enum(['FT', 'M', 'FL']).nullable(),
  referenceDatum: z.enum(['GND', 'MSL', 'STD']).nullable(),
})

const groundServiceJsonSchema = z.object({
  callsign: z.string().optional(),
  frequency: z.string().optional(),
}).optional()

const positionTupleSchema = z.tuple([z.number(), z.number()]).or(z.tuple([z.number(), z.number(), z.number()]))
const ringSchema = z.array(positionTupleSchema)
const polygonCoordsSchema = z.array(ringSchema)
const multiPolygonCoordsSchema = z.array(polygonCoordsSchema)

const apiAirspaceFeatureSchema = z.object({
  _id: z.string().optional(),
  name: z.string().min(1),
  type: z.string().min(1),
  class: z.string().optional(),
  activity: z.string().optional(),
  upperCeiling: verticalLimitJsonSchema,
  lowerCeiling: verticalLimitJsonSchema,
  activatedByNotam: z.boolean().optional(),
  groundService: groundServiceJsonSchema,
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

const verticalReferenceFrom = (raw: RawVerticalLimit): VerticalReference => normaliseVerticalLimit(raw).reference

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
  const lower = normaliseVerticalLimit(data.lowerCeiling)
  const upper = normaliseVerticalLimit(data.upperCeiling)
  const typeUpper = data.type.toUpperCase()
  const mapped = TYPE_TO_CATEGORY[typeUpper]
  let category: string
  if (mapped) {
    category = mapped
  } else {
    warnings.push(`unknown OpenAIP type "${data.type}"; using lowercase as category`)
    category = data.type.toLowerCase()
  }
  const classRaw = data.class?.toUpperCase()
  const classLetter = classRaw && classRaw !== 'UNCLASSIFIED' && /^[A-G]$/.test(classRaw)
    ? (classRaw as 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G')
    : null
  const frequencyStr = data.groundService?.frequency
  const frequencyMhz = frequencyStr && /^\d+(\.\d+)?$/.test(frequencyStr) ? Number(frequencyStr) : null
  const properties: AirspaceFeatureProperties = {
    name: data.name,
    category,
    classLetter,
    floorM: lower.metres,
    ceilingM: upper.metres,
    floorRef: verticalReferenceFrom(data.lowerCeiling),
    ceilingRef: verticalReferenceFrom(data.upperCeiling),
    floorLabel: lower.label,
    ceilingLabel: upper.label,
    activity: data.activity ?? null,
    activatedByNotam: data.activatedByNotam ?? false,
    frequencyMhz,
    callsign: data.groundService?.callsign ?? null,
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
  TYPE_TO_CATEGORY,
}
