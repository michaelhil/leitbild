import { readFile } from 'node:fs/promises'
import {
  asSourceId,
  type FetchCache,
  type RawBytes,
  type SourceId,
} from '../types.ts'
import { buildCacheEntry, conditionalGetHeaders } from '../fetch-cache.ts'

// Generic GeoNorge WFS GetFeature helper.
// Per-dataset parsing (e.g. Avinor airport points) lives in sibling source files;
// this helper handles WFS protocol concerns: URL composition, paged fetch, conditional
// GET, and detection of GeoNorge's "200 OK with ServiceExceptionReport" failure mode.

export type HttpFetch = (
  url: string,
  init?: { readonly method?: string; readonly headers?: Record<string, string> },
) => Promise<Response>

export interface WfsGetFeatureConfig {
  readonly sourceId: string
  readonly endpointUrl: string             // e.g. https://wfs.geonorge.no/skwms1/wfs.lufthavnpunkt_avinor
  readonly typeName: string                // e.g. app:Lufthavn
  readonly srsName?: string                // default urn:ogc:def:crs:EPSG::4326
  readonly count?: number                  // default 500
  readonly startIndex?: number             // default 0
  readonly fetchFn?: HttpFetch
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_SRS = 'urn:ogc:def:crs:EPSG::4326'
const DEFAULT_COUNT = 500
const MAX_PAGES = 50
const PAGE_DELIM = '\n--wfs-page-delim--\n'

const encoder = new TextEncoder()

const buildGetFeatureUrl = (
  endpoint: string,
  typeName: string,
  srsName: string,
  count: number,
  startIndex: number,
): string => {
  const url = new URL(endpoint)
  url.searchParams.set('service', 'WFS')
  url.searchParams.set('version', '2.0.0')
  url.searchParams.set('request', 'GetFeature')
  url.searchParams.set('typeNames', typeName)
  url.searchParams.set('count', String(count))
  url.searchParams.set('startIndex', String(startIndex))
  url.searchParams.set('srsName', srsName)
  return url.toString()
}

const looksLikeServiceException = (body: string): boolean => {
  const head = body.slice(0, 400)
  return head.includes('ServiceExceptionReport') || head.includes('ExceptionReport')
}

const extractExceptionText = (body: string): string => {
  const m = body.match(/<(?:ows:)?ExceptionText[^>]*>([\s\S]*?)<\/(?:ows:)?ExceptionText>/)
  if (m) return m[1]!.trim()
  // Anchor explicitly so <ServiceException ...> does not match <ServiceExceptionReport>.
  const m2 = body.match(/<ServiceException(?:\s[^>]*)?>([\s\S]*?)<\/ServiceException>/)
  if (m2) return m2[1]!.trim()
  return body.slice(0, 200).trim()
}

const countMembers = (body: string): number => {
  let count = 0
  let index = 0
  while (true) {
    const next = body.indexOf('<wfs:member', index)
    if (next < 0) break
    count += 1
    index = next + 1
  }
  return count
}

interface FetchedPage {
  readonly status: number
  readonly body: string
  readonly etag: string | null
  readonly lastModified: string | null
  readonly fromCache: boolean
}

const fetchPageOnce = async (
  url: string,
  fetchFn: HttpFetch,
  cache: FetchCache,
  pageId: SourceId,
): Promise<FetchedPage> => {
  const cached = await cache.read(pageId)
  const headers: Record<string, string> = {
    'accept': 'text/xml, application/gml+xml',
    ...conditionalGetHeaders(cached),
  }
  const response = await fetchFn(url, { method: 'GET', headers })
  const status = response.status
  if (status === 304) {
    if (!cached) throw new Error(`geonorge-wfs: server returned 304 but no cached body exists for ${url}`)
    const cachedBody = await readFile(cached.path, 'utf8')
    return {
      status: 200,
      body: cachedBody,
      etag: cached.etag,
      lastModified: cached.lastModified,
      fromCache: true,
    }
  }
  const body = await response.text()
  if (status < 200 || status >= 300) {
    const trimmed = body.length > 300 ? `${body.slice(0, 300)}…` : body
    throw new Error(`geonorge-wfs: HTTP ${status} for ${url} — ${trimmed}`)
  }
  if (looksLikeServiceException(body)) {
    throw new Error(`geonorge-wfs: server returned exception for ${url} — ${extractExceptionText(body)}`)
  }
  return {
    status,
    body,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    fromCache: false,
  }
}

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

export const fetchAllWfsPages = async (
  config: WfsGetFeatureConfig,
  cache: FetchCache,
): Promise<string> => {
  const fetchFn: HttpFetch = config.fetchFn ?? ((url, init) => globalThis.fetch(url, init))
  const srsName = config.srsName ?? DEFAULT_SRS
  const count = config.count ?? DEFAULT_COUNT
  let startIndex = config.startIndex ?? 0
  const bodies: string[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildGetFeatureUrl(config.endpointUrl, config.typeName, srsName, count, startIndex)
    const pageId = asSourceId(`${config.sourceId}:s${startIndex}`)
    const fetched = await fetchPageOnce(url, fetchFn, cache, pageId)
    await persistPage(cache, pageId, fetched)
    bodies.push(fetched.body)
    const returned = countMembers(fetched.body)
    if (returned < count) break
    startIndex += returned
    if (page === MAX_PAGES) {
      throw new Error(`geonorge-wfs: pagination did not terminate after ${MAX_PAGES} pages (count=${count})`)
    }
  }
  return bodies.join(PAGE_DELIM)
}

export const __internals = {
  buildGetFeatureUrl,
  looksLikeServiceException,
  extractExceptionText,
  countMembers,
  PAGE_DELIM,
}
