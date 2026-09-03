import { describe, expect, test } from 'bun:test'
import { decodeSource } from './adapters/decode.ts'
import { describeSourceAdapters } from './adapters/catalog.ts'
import { situationSourceSchema, situationConfigSchema, intersectsBounds, externalRecordSchema, recordSearchSchema, externalGeometrySchema } from './model.ts'
import { mapRecords, recordMapFeatures, watchedAreaFeatures } from './map.ts'
import { isPublicAddress, publicHttp } from './ingestion/public-http.ts'
import { createCollector, providerWaitSeconds } from './ingestion/collector.ts'
import { openRecordStore } from './ingestion/store.ts'

const now = '2026-09-03T12:00:00.000Z'
const rss = situationSourceSchema.parse({ id: 'news', name: 'News', adapter: 'rss', url: 'https://example.com/feed' })
const xml = '<rss><channel><item><guid>one</guid><title>Tokyo report</title><link>https://example.com/one</link><pubDate>Thu, 03 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>'
describe('Situation Monitor source boundary', () => {
  test('supports empty composition and discovers all exact schemas', () => { expect(situationConfigSchema.parse({})).toEqual({ areas: [], sources: [] }); expect(describeSourceAdapters()).toHaveLength(5) })
  test('honours provider deadlines beyond a day and cached response age', () => {
    expect(providerWaitSeconds({ 'retry-after': '172800' }, Date.parse(now))).toBe(172800)
    expect(providerWaitSeconds({ 'cache-control': 'public, max-age=3600', age: '600' }, Date.parse(now))).toBe(3000)
    expect(providerWaitSeconds({ expires: 'Sat, 05 Sep 2026 12:00:00 GMT' }, Date.parse(now))).toBe(172800)
    expect(providerWaitSeconds({ 'retry-after': 'invalid', expires: 'invalid' }, Date.parse(now))).toBe(0)
  })
  test('rejects duplicate IDs and credential-bearing URLs', () => {
    expect(() => situationConfigSchema.parse({ sources: [rss, rss] })).toThrow('unique')
    expect(() => situationSourceSchema.parse({ ...rss, url: 'https://example.com/?api_key=secret' })).toThrow('Credentials')
  })
  test('parses RSS without inventing a location', () => { const [record] = decodeSource(rss, xml, now); expect(record!.title).toBe('Tokyo report'); expect(record!.geometry).toBeUndefined(); expect(record!.publishedAt).toBe(now) })
  test('parses Atom and rejects non-feed, entity and unsafe-link input', () => {
    expect(decodeSource(rss, '<feed><entry><id>a</id><title>Report</title><link href="https://example.com/a"/></entry></feed>', now)[0]!.url).toBe('https://example.com/a')
    expect(() => decodeSource(rss, '<html/>', now)).toThrow('RSS or Atom')
    expect(() => decodeSource(rss, '<!DOCTYPE feed><feed/>', now)).toThrow('entities')
    expect(() => decodeSource(rss, xml.replace('https://example.com/one', 'javascript:alert(1)'), now)).toThrow()
  })
  test('HTML inside CDATA is text, while external declarations and excessive nesting are rejected', () => {
    const feed = '<rss><channel><item><guid>one</guid><title>Report</title><description><![CDATA[<!DOCTYPE html><p>Permitted excerpt</p>]]></description></item></channel></rss>'
    expect(decodeSource(rss, feed, now)[0]!.summary).toBe('Permitted excerpt')
    expect(() => decodeSource(rss, '<rss>' + '<n>'.repeat(100) + '</n>'.repeat(100) + '</rss>', now)).toThrow()
  })
  test('indexed search scopes sources, time, text, dateline areas and pagination before decoding', () => {
    const store = openRecordStore(':memory:')
    try {
      const record = externalRecordSchema.parse({ id: 'located', sourceId: 'original', kind: 'event', title: 'Pacific report', url: 'https://example.com/event', attribution: 'Provider', retrievedAt: now, geometry: { type: 'Point', coordinates: [179,30] } })
      store.replace('pacific', [record], 1, true)
      store.replace('news', [{ ...record, id: 'unlocated', geometry: undefined }], 1, true)
      const sources = [{ id: 'shared-a', key: 'pacific' }, { id: 'shared-b', key: 'pacific' }, { id: 'news', key: 'news' }]
      const all = store.search(sources, recordSearchSchema.parse({ text: 'pacific', limit: 1 }), [])
      expect(all.total).toBe(3); expect(all.hasMore).toBe(true); expect(all.records).toHaveLength(1)
      expect(store.search(sources, recordSearchSchema.parse({ bounds: [170,20,-170,40] }), []).total).toBe(2)
      expect(store.search(sources, recordSearchSchema.parse({ sourceId: 'shared-b' }), []).records[0]!.sourceId).toBe('shared-b')
      expect(store.search(sources, recordSearchSchema.parse({ from: '2027-01-01T00:00:00Z' }), []).total).toBe(0)
      expect(store.search(sources, recordSearchSchema.parse({}), [{ id: 'europe', name: 'Europe', bounds: [-10,20,40,70] }]).records.map(record => record.id)).toEqual(['unlocated'])
      store.cleanup(Date.now() + 3600001)
      expect(store.search(sources, recordSearchSchema.parse({}), []).total).toBe(0)
    } finally { store.close() }
  })
  test('map keeps multi-geometries native and chooses one explicitly valid forecast per source', () => {
    const record = externalRecordSchema.parse({ id: 'first', sourceId: 'forecast', kind: 'forecast', title: 'Tokyo', url: 'https://example.com/', attribution: 'Provider', retrievedAt: now, validAt: now, geometry: { type: 'Point', coordinates: [139,35] } })
    expect(mapRecords([record, { ...record, id: 'later', validAt: '2026-09-04T12:00:00.000Z' }], Date.parse(now))).toEqual([record])
    expect(recordMapFeatures({ ...record, geometry: { type: 'MultiPoint', coordinates: [[139,35],[140,36]] } })).toHaveLength(2)
    expect(watchedAreaFeatures([{ id: 'pacific', name: 'Pacific', bounds: [170,-10,-170,10] }])).toHaveLength(2)
    expect(() => externalGeometrySchema.parse({ type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1]]] })).toThrow('closed')
  })
  test('cache enforces record budgets without losing the previous snapshot', () => {
    const store = openRecordStore(':memory:', { maxBytes: 1000000, maxRecords: 1, minFreeBytes: 0 })
    try {
      const record = decodeSource(rss, xml, now)[0]!
      store.replace('test', [record], 1, true)
      expect(() => store.replace('test', [record, { ...record, id: 'second' }], 1, true)).toThrow('record budget')
      expect(store.count('test')).toBe(1)
    } finally { store.close() }
  })
  test('preserves earthquake magnitude/depth and ignores altitude in map geometry', () => {
    const source = situationSourceSchema.parse({ ...rss, adapter: 'usgs' })
    const records = decodeSource(source, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'quake', geometry: { type: 'Point', coordinates: [140, 36, 8] }, properties: { title: 'Earthquake', mag: 4.2, magType: 'mw', time: Date.parse(now), updated: Date.parse(now), url: 'https://example.com/quake' } }] }), now)
    expect(records[0]!.geometry).toEqual({ type: 'Point', coordinates: [140, 36] }); expect(records[0]!.measurements[1]!.value).toBe(8)
  })
  test('dateline-aware watched areas and non-Norwegian points', () => {
    expect(intersectsBounds([179, -10, 179, 10], [170, -20, -170, 20])).toBe(true)
    expect(intersectsBounds([0, -10, 0, 10], [170, -20, -170, 20])).toBe(false)
    expect(situationSourceSchema.parse({ id: 'weather', name: 'Sydney', adapter: 'met-forecast', point: [151.2, -33.8] }).adapter).toBe('met-forecast')
  })
  test('rejects private, mapped and reserved network targets', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.2', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) expect(isPublicAddress(ip)).toBe(false)
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
    await expect(publicHttp('https://127.0.0.1/')).rejects.toThrow('public internet')
  })
  test('cache bounds, snapshot replacement and same-source collector sharing', async () => {
    const store = openRecordStore(':memory:'), records = decodeSource(rss, xml, now)
    store.replace('test', records, 24, true); expect(store.count('test')).toBe(1)
    store.replace('test', [], 24, true); expect(store.count('test')).toBe(0)
    let calls = 0
    const collector = createCollector(store, async () => { calls++; return { status: 200, text: xml, headers: {} } })
    const first = collector.acquire(rss, () => {}), second = collector.acquire({ ...rss, id: 'second' }, () => {})
    await Bun.sleep(20)
    expect(calls).toBe(1); expect(first.key).toBe(second.key); expect(first.status().recordCount).toBe(1)
    await first.release(); expect(second.status().state).toBe('ready')
    await second.release(); await collector.close()
  })
})
