import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'
import { __internals, openAipAirspaceSource, type HttpFetch } from '../src/reference-data/sources/openaip.ts'
import { airspaceFeatureSchema } from '../src/reference-data/airspace-schema.ts'

const fixturePath = (name: string) => join(import.meta.dir, 'fixtures', name)

const fixtureBody = async (name: string): Promise<string> => readFile(fixturePath(name), 'utf8')

interface FakeResponseConfig {
  readonly status: number
  readonly body: string
  readonly etag?: string | null
  readonly lastModified?: string | null
  readonly retryAfter?: string | null
}

const makeFakeResponse = (config: FakeResponseConfig): Response => {
  const headers = new Headers()
  if (config.etag) headers.set('etag', config.etag)
  if (config.lastModified) headers.set('last-modified', config.lastModified)
  if (config.retryAfter) headers.set('retry-after', config.retryAfter)
  return new Response(config.body, { status: config.status, headers })
}

interface FakeFetchScript {
  readonly responses: ReadonlyArray<FakeResponseConfig>
  readonly capturedRequests: Array<{ readonly url: string; readonly headers: Record<string, string> }>
}

const fakeFetcher = (responses: ReadonlyArray<FakeResponseConfig>): {
  readonly fetchFn: HttpFetch
  readonly script: FakeFetchScript
} => {
  let index = 0
  const captured: FakeFetchScript['capturedRequests'] = []
  const fetchFn: HttpFetch = async (
    url: string,
    init?: { readonly method?: string; readonly headers?: Record<string, string> },
  ): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (init?.headers) for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = String(v)
    captured.push({ url, headers })
    if (index >= responses.length) throw new Error(`fake fetcher: out of scripted responses (call ${index + 1})`)
    const r = responses[index]!
    index += 1
    return makeFakeResponse(r)
  }
  return { fetchFn, script: { responses, capturedRequests: captured } }
}

const cacheRoot = async (): Promise<{ readonly root: string; readonly cache: ReturnType<typeof createFetchCache> }> => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-openaip-'))
  return { root, cache: createFetchCache(root) }
}

describe('openAipAirspaceSource', () => {
  test('factory throws without apiKey', () => {
    expect(() => openAipAirspaceSource({ id: 'x', apiKey: '', country: 'NO' })).toThrow(/apiKey/)
  })

  test('factory throws on bad country code', () => {
    expect(() => openAipAirspaceSource({ id: 'x', apiKey: 'k', country: 'NOR' })).toThrow(/ISO-3166-1/)
    expect(() => openAipAirspaceSource({ id: 'x', apiKey: 'k', country: 'no' })).toThrow(/ISO-3166-1/)
  })

  test('paginates until a short page, sends api key header, normalises features', async () => {
    const { cache } = await cacheRoot()
    const page1 = await fixtureBody('openaip-airspaces-no-page1.json')
    const page2 = await fixtureBody('openaip-airspaces-no-page2.json')
    const { fetchFn, script } = fakeFetcher([
      { status: 200, body: page1, etag: 'etag-p1' },
      { status: 200, body: page2, etag: 'etag-p2' },
    ])
    const source = openAipAirspaceSource({
      id: 'openaip:airspaces:NO',
      apiKey: 'test-key',
      country: 'NO',
      limit: 4,
      fetchFn,
    })
    if (source.kind !== 'remote') throw new Error('expected remote source')
    const raw = await source.fetch(cache)
    const features = await source.parse(raw)
    expect(features.length).toBe(6)

    // Auth header on every request.
    for (const req of script.capturedRequests) {
      expect(req.headers['x-openaip-api-key']).toBe('test-key')
    }

    // Two requests total (page1 limit==4, page2 returns 2 < limit -> stop).
    expect(script.capturedRequests.length).toBe(2)
    expect(script.capturedRequests[0]!.url).toContain('country=NO')
    expect(script.capturedRequests[0]!.url).toContain('page=1')
    expect(script.capturedRequests[1]!.url).toContain('page=2')

    // Every normalised feature passes the canonical airspace schema.
    for (const feature of features) {
      airspaceFeatureSchema.parse(feature.properties)
    }

    // Spot-check known fixtures.
    const oslo = features.find(f => f.id === 'fixture-oslo-tma')!
    expect(oslo.properties.category).toBe('tma')
    expect(oslo.properties.classLetter).toBe('C')
    expect(oslo.properties.ceilingLabel).toBe('FL245')
    expect((oslo.properties.ceilingM as number)).toBeCloseTo(7467.6, 1)
    expect(oslo.properties.frequencyMhz).toBe(120)
    expect(oslo.properties.callsign).toBe('OSLO APPROACH')

    const halden = features.find(f => f.id === 'fixture-r-zone-halden')!
    expect(halden.properties.category).toBe('restricted')
    expect(halden.properties.activatedByNotam).toBe(true)
    expect(halden.properties.floorLabel).toBe('GND')

    // Unlimited ceiling fixture (page 2).
    const stavanger = features.find(f => f.id === 'fixture-stavanger-tma-multi')!
    expect(stavanger.geometry.type).toBe('MultiPolygon')
    expect(stavanger.properties.ceilingM).toBeNull()
    expect(stavanger.properties.ceilingRef).toBe('UNL')

    // Unknown OpenAIP type falls back to lowercased category.
    const mystery = features.find(f => f.id === 'fixture-novel-type')!
    expect(mystery.properties.category).toBe('something_new_from_the_api')
  })

  test('persists each page to the fetch cache with sha and etag', async () => {
    const { cache } = await cacheRoot()
    const page1 = await fixtureBody('openaip-airspaces-no-page1.json')
    const page2 = await fixtureBody('openaip-airspaces-no-page2.json')
    const { fetchFn } = fakeFetcher([
      { status: 200, body: page1, etag: 'etag-p1' },
      { status: 200, body: page2, etag: 'etag-p2' },
    ])
    const source = openAipAirspaceSource({ id: 'openaip:cached', apiKey: 'k', country: 'NO', limit: 4, fetchFn })
    if (source.kind !== 'remote') throw new Error('expected remote source')
    await source.fetch(cache)
    const p1Entry = await cache.read('openaip:cached:p1' as never)
    const p2Entry = await cache.read('openaip:cached:p2' as never)
    expect(p1Entry?.etag).toBe('etag-p1')
    expect(p2Entry?.etag).toBe('etag-p2')
    expect(p1Entry?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('conditional GET: 304 reads previous body from cache', async () => {
    const { cache } = await cacheRoot()
    const page1 = await fixtureBody('openaip-airspaces-no-page1.json')
    const page2 = await fixtureBody('openaip-airspaces-no-page2.json')

    // First fetch primes the cache.
    const primer = fakeFetcher([
      { status: 200, body: page1, etag: 'etag-p1' },
      { status: 200, body: page2, etag: 'etag-p2' },
    ])
    const sourceA = openAipAirspaceSource({
      id: 'openaip:cond', apiKey: 'k', country: 'NO', limit: 4, fetchFn: primer.fetchFn,
    })
    if (sourceA.kind !== 'remote') throw new Error('expected remote source')
    await sourceA.fetch(cache)

    // Second fetch: server returns 304 for both pages.
    const conditional = fakeFetcher([
      { status: 304, body: '', etag: 'etag-p1' },
      { status: 304, body: '', etag: 'etag-p2' },
    ])
    const sourceB = openAipAirspaceSource({
      id: 'openaip:cond', apiKey: 'k', country: 'NO', limit: 4, fetchFn: conditional.fetchFn,
    })
    if (sourceB.kind !== 'remote') throw new Error('expected remote source')
    const raw = await sourceB.fetch(cache)
    const features = await sourceB.parse(raw)
    expect(features.length).toBe(6)
    for (const req of conditional.script.capturedRequests) {
      expect(req.headers['if-none-match']).toMatch(/^etag-p\d$/)
    }
  })

  test('429 triggers backoff and then succeeds on retry', async () => {
    const { cache } = await cacheRoot()
    const page1 = await fixtureBody('openaip-airspaces-no-page1.json')
    const page2 = await fixtureBody('openaip-airspaces-no-page2.json')
    let slept = 0
    const { fetchFn } = fakeFetcher([
      { status: 429, body: '{"error":"slow down"}', retryAfter: '1' },
      { status: 200, body: page1, etag: 'etag-p1' },
      { status: 200, body: page2, etag: 'etag-p2' },
    ])
    const source = openAipAirspaceSource({
      id: 'openaip:backoff', apiKey: 'k', country: 'NO', limit: 4, fetchFn,
      sleep: async (ms) => { slept = ms },
    })
    if (source.kind !== 'remote') throw new Error('expected remote source')
    const raw = await source.fetch(cache)
    const features = await source.parse(raw)
    expect(features.length).toBe(6)
    expect(slept).toBe(1000)
  })

  test('non-2xx non-429 status throws with body excerpt', async () => {
    const { cache } = await cacheRoot()
    const { fetchFn } = fakeFetcher([
      { status: 403, body: '{"message":"forbidden"}' },
    ])
    const source = openAipAirspaceSource({
      id: 'openaip:err', apiKey: 'k', country: 'NO', fetchFn,
    })
    if (source.kind !== 'remote') throw new Error('expected remote source')
    await expect(source.fetch(cache)).rejects.toThrow(/HTTP 403/)
  })
})

describe('openaip url building', () => {
  test('includes bbox when provided', () => {
    const url = __internals.buildAirspaceUrl(
      { id: 'x', apiKey: 'k', country: 'NO', bbox: [3, 57, 32, 71] },
      1,
      1000,
    )
    expect(url).toContain('bbox=3%2C57%2C32%2C71')
    expect(url).toContain('page=1')
    expect(url).toContain('limit=1000')
  })

  test('parseRetryAfter accepts numeric seconds', () => {
    expect(__internals.parseRetryAfter('30')).toBe(30)
  })

  test('parseRetryAfter accepts HTTP date', () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const sec = __internals.parseRetryAfter(future)
    expect(sec).not.toBeNull()
    expect(sec!).toBeGreaterThan(0)
    expect(sec!).toBeLessThanOrEqual(60)
  })

  test('exponentialBackoffMs grows then caps', () => {
    expect(__internals.exponentialBackoffMs(1)).toBe(2000)
    expect(__internals.exponentialBackoffMs(2)).toBe(4000)
    expect(__internals.exponentialBackoffMs(10)).toBeLessThanOrEqual(60000)
  })
})
