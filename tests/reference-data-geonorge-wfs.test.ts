import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'
import { __internals, fetchAllWfsPages, type HttpFetch } from '../src/reference-data/sources/geonorge-wfs.ts'

interface FakeResponseConfig {
  readonly status: number
  readonly body: string
  readonly etag?: string | null
}

const makeFakeResponse = (config: FakeResponseConfig): Response => {
  const headers = new Headers()
  if (config.etag) headers.set('etag', config.etag)
  return new Response(config.body, { status: config.status, headers })
}

const fakeFetcher = (responses: ReadonlyArray<FakeResponseConfig>): {
  readonly fetchFn: HttpFetch
  readonly capturedUrls: string[]
} => {
  let i = 0
  const capturedUrls: string[] = []
  const fetchFn: HttpFetch = async (url) => {
    capturedUrls.push(url)
    if (i >= responses.length) throw new Error(`fake fetcher: out of scripted responses (call ${i + 1})`)
    const r = responses[i]!
    i += 1
    return makeFakeResponse(r)
  }
  return { fetchFn, capturedUrls }
}

const cacheRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-geonorge-wfs-'))
  return { cache: createFetchCache(root) }
}

const memberXml = (n: number) => `<wfs:member><app:Thing>${n}</app:Thing></wfs:member>`
const featureCollectionXml = (members: number) => {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<wfs:FeatureCollection xmlns:wfs="x">']
  for (let i = 0; i < members; i++) parts.push(memberXml(i))
  parts.push('</wfs:FeatureCollection>')
  return parts.join('\n')
}

describe('geonorge-wfs URL builder', () => {
  test('emits canonical WFS 2.0.0 GetFeature URL', () => {
    const url = __internals.buildGetFeatureUrl(
      'https://wfs.geonorge.no/skwms1/wfs.lufthavnpunkt_avinor',
      'app:Lufthavn',
      'urn:ogc:def:crs:EPSG::4326',
      500,
      0,
    )
    expect(url).toContain('service=WFS')
    expect(url).toContain('version=2.0.0')
    expect(url).toContain('request=GetFeature')
    expect(url).toContain('typeNames=app%3ALufthavn')
    expect(url).toContain('count=500')
    expect(url).toContain('startIndex=0')
    expect(url).toContain('srsName=urn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A4326')
  })
})

describe('geonorge-wfs exception detection', () => {
  test('detects ows:ExceptionReport', () => {
    const body = '<?xml version="1.0"?><ows:ExceptionReport><ows:ExceptionText>bad param</ows:ExceptionText></ows:ExceptionReport>'
    expect(__internals.looksLikeServiceException(body)).toBe(true)
    expect(__internals.extractExceptionText(body)).toBe('bad param')
  })
  test('detects legacy ServiceExceptionReport', () => {
    const body = '<?xml?><ServiceExceptionReport><ServiceException>unknown</ServiceException></ServiceExceptionReport>'
    expect(__internals.looksLikeServiceException(body)).toBe(true)
    expect(__internals.extractExceptionText(body)).toBe('unknown')
  })
  test('returns false for normal feature collection', () => {
    expect(__internals.looksLikeServiceException(featureCollectionXml(2))).toBe(false)
  })
})

describe('countMembers', () => {
  test('counts wfs:member occurrences', () => {
    expect(__internals.countMembers(featureCollectionXml(0))).toBe(0)
    expect(__internals.countMembers(featureCollectionXml(1))).toBe(1)
    expect(__internals.countMembers(featureCollectionXml(7))).toBe(7)
  })
})

describe('fetchAllWfsPages', () => {
  test('single page when returned < count', async () => {
    const { cache } = await cacheRoot()
    const { fetchFn, capturedUrls } = fakeFetcher([
      { status: 200, body: featureCollectionXml(3), etag: 'etag-0' },
    ])
    const xml = await fetchAllWfsPages({
      sourceId: 'test',
      endpointUrl: 'https://example.org/wfs',
      typeName: 'app:Lufthavn',
      count: 500,
      fetchFn,
    }, cache)
    expect(xml).toContain('FeatureCollection')
    expect(capturedUrls.length).toBe(1)
    expect(capturedUrls[0]!).toContain('startIndex=0')
  })

  test('paginates when first page is full', async () => {
    const { cache } = await cacheRoot()
    const { fetchFn, capturedUrls } = fakeFetcher([
      { status: 200, body: featureCollectionXml(5), etag: 'e1' },
      { status: 200, body: featureCollectionXml(3), etag: 'e2' },
    ])
    await fetchAllWfsPages({
      sourceId: 'test',
      endpointUrl: 'https://example.org/wfs',
      typeName: 'app:Lufthavn',
      count: 5,
      fetchFn,
    }, cache)
    expect(capturedUrls.length).toBe(2)
    expect(capturedUrls[0]!).toContain('startIndex=0')
    expect(capturedUrls[1]!).toContain('startIndex=5')
  })

  test('HTTP 500 throws with body excerpt', async () => {
    const { cache } = await cacheRoot()
    const { fetchFn } = fakeFetcher([
      { status: 500, body: 'server is down' },
    ])
    await expect(fetchAllWfsPages({
      sourceId: 'err',
      endpointUrl: 'https://example.org/wfs',
      typeName: 'app:Lufthavn',
      fetchFn,
    }, cache)).rejects.toThrow(/HTTP 500/)
  })

  test('200 with ServiceExceptionReport throws', async () => {
    const { cache } = await cacheRoot()
    const xml = '<?xml?><ServiceExceptionReport><ServiceException>UNKNOWN_APP</ServiceException></ServiceExceptionReport>'
    const { fetchFn } = fakeFetcher([
      { status: 200, body: xml },
    ])
    await expect(fetchAllWfsPages({
      sourceId: 'exc',
      endpointUrl: 'https://example.org/wfs',
      typeName: 'app:Lufthavn',
      fetchFn,
    }, cache)).rejects.toThrow(/UNKNOWN_APP/)
  })

  test('304 reads cached body', async () => {
    const { cache } = await cacheRoot()
    // Prime cache
    const primer = fakeFetcher([{ status: 200, body: featureCollectionXml(2), etag: 'e' }])
    await fetchAllWfsPages({
      sourceId: 'cached',
      endpointUrl: 'https://example.org/wfs',
      typeName: 'app:Lufthavn',
      fetchFn: primer.fetchFn,
    }, cache)
    // Now 304
    const conditional = fakeFetcher([{ status: 304, body: '', etag: 'e' }])
    const xml = await fetchAllWfsPages({
      sourceId: 'cached',
      endpointUrl: 'https://example.org/wfs',
      typeName: 'app:Lufthavn',
      fetchFn: conditional.fetchFn,
    }, cache)
    expect(__internals.countMembers(xml)).toBe(2)
  })
})
