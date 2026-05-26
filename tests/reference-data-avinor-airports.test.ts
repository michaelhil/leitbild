import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { airportFeatureSchema } from '../src/reference-data/airport-schema.ts'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'
import {
  __internals,
  avinorAirportsSource,
  parseAvinorAirportBlock,
  parseAvinorAirportsGml,
} from '../src/reference-data/sources/avinor-airports.ts'
import type { HttpFetch } from '../src/reference-data/sources/geonorge-wfs.ts'

const fixturePath = join(import.meta.dir, 'fixtures', 'avinor-lufthavn-sample.xml')

const loadFixture = (): Promise<string> => readFile(fixturePath, 'utf8')

const cacheRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-avinor-'))
  return { cache: createFetchCache(root) }
}

describe('parseAvinorAirportsGml', () => {
  test('extracts three features from the real fixture', async () => {
    const xml = await loadFixture()
    const { features, skipped } = parseAvinorAirportsGml(xml)
    expect(features.length).toBe(3)
    expect(skipped).toEqual([])
  })

  test('every feature passes the canonical airport schema', async () => {
    const xml = await loadFixture()
    const { features } = parseAvinorAirportsGml(xml)
    for (const f of features) airportFeatureSchema.parse(f.properties)
  })

  test('axis swap: longitudes in [4,32] and latitudes in [57,72] for Norway', async () => {
    const xml = await loadFixture()
    const { features } = parseAvinorAirportsGml(xml)
    for (const f of features) {
      expect(f.geometry.type).toBe('Point')
      if (f.geometry.type !== 'Point') continue
      const [lon, lat] = f.geometry.coordinates
      expect(lon).toBeGreaterThanOrEqual(4)
      expect(lon).toBeLessThanOrEqual(32)
      expect(lat).toBeGreaterThanOrEqual(57)
      expect(lat).toBeLessThanOrEqual(72)
    }
  })

  test('spot-check Ålesund (norwegian characters, has IATA)', async () => {
    const xml = await loadFixture()
    const { features } = parseAvinorAirportsGml(xml)
    const ales = features.find(f => f.id === 'lufthavn.1')!
    expect(ales.properties.name).toBe('Ålesund lufthavn, Vigra')
    expect(ales.properties.icao).toBe('ENAL')
    expect(ales.properties.iata).toBe('AES')
    expect(ales.properties.elevationM).toBeCloseTo(21.4, 3)
    expect(ales.properties.country).toBe('NO')
    expect(ales.properties.source).toBe('geonorge:lufthavnpunkt_avinor')
  })

  test('spot-check Alta', async () => {
    const xml = await loadFixture()
    const { features } = parseAvinorAirportsGml(xml)
    const alta = features.find(f => f.id === 'lufthavn.3')!
    expect(alta.properties.name).toBe('Alta lufthavn')
    expect(alta.properties.icao).toBe('ENAT')
    expect(alta.properties.iata).toBe('ALF')
  })

  test('missing IATA code is preserved as null', async () => {
    const xml = await loadFixture()
    const { features } = parseAvinorAirportsGml(xml)
    const torp = features.find(f => f.id === 'lufthavn.test-noiata')!
    expect(torp.properties.name).toContain('Sandefjord')
    expect(torp.properties.icao).toBe('ENTO')
    expect(torp.properties.iata).toBeNull()
  })
})

describe('parseAvinorAirportBlock edge cases', () => {
  test('missing gml:id skips with reason', () => {
    const block = '<app:Lufthavn><app:lufthavnnavn>x</app:lufthavnnavn></app:Lufthavn>'
    const result = parseAvinorAirportBlock(block)
    expect('skipReason' in result && result.skipReason).toMatch(/gml:id/)
  })

  test('missing name skips with reason', () => {
    const block = '<app:Lufthavn gml:id="x"></app:Lufthavn>'
    const result = parseAvinorAirportBlock(block)
    expect('skipReason' in result && result.skipReason).toMatch(/lufthavnnavn/)
  })

  test('missing pos skips with reason', () => {
    const block = '<app:Lufthavn gml:id="x"><app:lufthavnnavn>X</app:lufthavnnavn></app:Lufthavn>'
    const result = parseAvinorAirportBlock(block)
    expect('skipReason' in result && result.skipReason).toMatch(/gml:pos/)
  })

  test('invalid ICAO format coerced to null', () => {
    const block = `<app:Lufthavn gml:id="x">
      <app:lufthavnnavn>Test</app:lufthavnnavn>
      <app:ICAOKode>BAD-FORMAT</app:ICAOKode>
      <app:posisjon><gml:Point><gml:pos>60 11</gml:pos></gml:Point></app:posisjon>
    </app:Lufthavn>`
    const result = parseAvinorAirportBlock(block)
    expect('feature' in result && result.feature?.properties.icao).toBeNull()
  })

  test('comments are stripped before parsing', () => {
    const block = `<app:Lufthavn gml:id="x">
      <!-- inline comment -->
      <app:lufthavnnavn>Test</app:lufthavnnavn>
      <app:posisjon><!-- comment --><gml:Point><gml:pos>60 11</gml:pos></gml:Point></app:posisjon>
    </app:Lufthavn>`
    const stripped = __internals.stripXmlComments(block)
    expect(stripped).not.toContain('<!--')
    const result = parseAvinorAirportBlock(stripped)
    expect('feature' in result && result.feature?.id).toBe('x')
  })

  test('pos with extra whitespace tokenises correctly', () => {
    const block = `<app:Lufthavn gml:id="x">
      <app:lufthavnnavn>T</app:lufthavnnavn>
      <app:posisjon><gml:Point><gml:pos>   60.5    11.25   </gml:pos></gml:Point></app:posisjon>
    </app:Lufthavn>`
    const result = parseAvinorAirportBlock(block)
    if (!('feature' in result) || !result.feature) throw new Error('expected parsed feature')
    if (result.feature.geometry.type !== 'Point') throw new Error('expected Point')
    expect(result.feature.geometry.coordinates[0]).toBe(11.25)
    expect(result.feature.geometry.coordinates[1]).toBe(60.5)
  })
})

describe('avinorAirportsSource (factory)', () => {
  test('end-to-end: fetch + parse via injected fetcher', async () => {
    const { cache } = await cacheRoot()
    const fixture = await loadFixture()
    const fetchFn: HttpFetch = async () =>
      new Response(fixture, { status: 200, headers: { etag: 'sample-etag' } })
    const source = avinorAirportsSource({ fetchFn })
    if (source.kind !== 'remote') throw new Error('expected remote source')
    const raw = await source.fetch(cache)
    const features = await source.parse(raw)
    expect(features.length).toBe(3)
    for (const f of features) airportFeatureSchema.parse(f.properties)
  })
})
