import { asSourceId, type DatasetSource, type NormalizedFeature } from '../../../reference-data/types.ts'
import type { AirportFeatureProperties } from '../schemas/airport.ts'
import { fetchAllWfsPages, type HttpFetch } from '../../../reference-data/sources/geonorge-wfs.ts'

// GeoNorge "Lufthavnpunkt Avinor" WFS source. Reads GML 3.2.1 responses, extracts
// app:Lufthavn features, swaps lat/lon to GeoJSON lon/lat order, and emits canonical
// airport features.
//
// Why hand-rolled XML parsing:
//   - The SOSI Lufthavn product spec is version-pinned (20181115); the shape is
//     extremely simple and stable.
//   - Each feature has a flat tree of named text children plus one gml:Point/gml:pos.
//   - Adding an XML library dep for this single targeted parse is over-engineering.
//   - The reader is golden-tested against a real fetched WFS response.
//
// Axis-order trap: with srsName=urn:ogc:def:crs:EPSG::4326 the EPSG-defined axis
// order is (latitude, longitude). gml:pos emits "lat lon" in that case. We swap
// to GeoJSON's [lon, lat] inside this parser and never let the swapped/unswapped
// distinction leak outward.

const PAGE_DELIM = '\n--wfs-page-delim--\n'

const AVINOR_ENDPOINT = 'https://wfs.geonorge.no/skwms1/wfs.lufthavnpunkt_avinor'
const AVINOR_TYPENAME = 'app:Lufthavn'

export interface AvinorAirportsSourceConfig {
  readonly id?: string
  readonly fetchFn?: HttpFetch
}

const stripXmlComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, '')

const extractMemberBlocks = (xml: string): string[] => {
  const cleaned = stripXmlComments(xml)
  const blocks: string[] = []
  const memberOpenRe = /<wfs:member[^>]*>/g
  const memberCloseTag = '</wfs:member>'
  let match: RegExpExecArray | null
  while ((match = memberOpenRe.exec(cleaned)) !== null) {
    const start = match.index + match[0].length
    const end = cleaned.indexOf(memberCloseTag, start)
    if (end < 0) break
    blocks.push(cleaned.slice(start, end))
    memberOpenRe.lastIndex = end + memberCloseTag.length
  }
  return blocks
}

const decodeXmlEntities = (text: string): string =>
  text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")

const textOf = (block: string, localName: string): string | null => {
  // Tolerant of any prefix: match `<*:localName>` or `<localName>`.
  const re = new RegExp(`<(?:\\w+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, 'i')
  const m = block.match(re)
  if (!m) return null
  const inner = m[1]!.trim()
  if (inner.length === 0) return null
  return decodeXmlEntities(inner)
}

const attrOf = (block: string, localName: string, attr: string): string | null => {
  const re = new RegExp(`<(?:\\w+:)?${localName}\\s[^>]*${attr}\\s*=\\s*"([^"]+)"`, 'i')
  const m = block.match(re)
  return m ? decodeXmlEntities(m[1]!) : null
}

const parsePos = (block: string): { readonly lon: number; readonly lat: number } | null => {
  const posText = textOf(block, 'pos')
  if (!posText) return null
  const parts = posText.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  // srsName urn:ogc:def:crs:EPSG::4326 is lat/lon order. We always request that
  // srsName, so swap to GeoJSON lon/lat.
  const lat = Number(parts[0])
  const lon = Number(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lon, lat }
}

const validIcao = (raw: string | null): string | null => {
  if (!raw) return null
  const upper = raw.toUpperCase().trim()
  return /^[A-Z]{4}$/.test(upper) ? upper : null
}

const validIata = (raw: string | null): string | null => {
  if (!raw) return null
  const upper = raw.toUpperCase().trim()
  return /^[A-Z]{3}$/.test(upper) ? upper : null
}

const numericOrNull = (raw: string | null): number | null => {
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export interface ParsedAvinorAirport {
  readonly feature: NormalizedFeature
  readonly skipReason?: never
}

export interface SkippedAvinorAirport {
  readonly feature?: never
  readonly skipReason: string
}

export const parseAvinorAirportBlock = (block: string): ParsedAvinorAirport | SkippedAvinorAirport => {
  const gmlId = attrOf(block, 'Lufthavn', 'gml:id') ?? attrOf(block, 'Lufthavn', 'id')
  if (!gmlId) return { skipReason: 'missing gml:id on Lufthavn' }
  const name = textOf(block, 'lufthavnnavn')
  if (!name) return { skipReason: `${gmlId}: missing lufthavnnavn` }
  const pos = parsePos(block)
  if (!pos) return { skipReason: `${gmlId}: missing or invalid gml:pos` }
  const localId = textOf(block, 'lokalId') ?? gmlId
  const icao = validIcao(textOf(block, 'ICAOKode'))
  const iata = validIata(textOf(block, 'IATAKode'))
  const elevationRaw = textOf(block, 'høydeOverHavet') ?? textOf(block, 'hoydeOverHavet')
  const elevationM = numericOrNull(elevationRaw)
  const municipalityCode = textOf(block, 'kommunenummer')

  const properties: AirportFeatureProperties = {
    name,
    icao,
    iata,
    elevationM,
    municipalityCode,
    localId,
    country: 'NO',
    source: 'geonorge:lufthavnpunkt_avinor',
    sourceExternalId: gmlId,
  }
  const feature: NormalizedFeature = {
    type: 'Feature',
    id: gmlId,
    geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] as const },
    properties,
  }
  return { feature }
}

export const parseAvinorAirportsGml = (xml: string): {
  readonly features: ReadonlyArray<NormalizedFeature>
  readonly skipped: ReadonlyArray<string>
} => {
  const features: NormalizedFeature[] = []
  const skipped: string[] = []
  const pages = xml.split(PAGE_DELIM)
  for (const page of pages) {
    if (page.length === 0) continue
    for (const block of extractMemberBlocks(page)) {
      const result = parseAvinorAirportBlock(block)
      if ('feature' in result && result.feature) features.push(result.feature)
      else if ('skipReason' in result && result.skipReason) skipped.push(result.skipReason)
    }
  }
  return { features, skipped }
}

export const avinorAirportsSource = (config: AvinorAirportsSourceConfig = {}): DatasetSource => {
  const id = config.id ?? 'geonorge:lufthavnpunkt_avinor'
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  return {
    kind: 'remote',
    id: asSourceId(id),
    fetch: async (cache) => {
      const xml = await fetchAllWfsPages({
        sourceId: id,
        endpointUrl: AVINOR_ENDPOINT,
        typeName: AVINOR_TYPENAME,
        ...(config.fetchFn ? { fetchFn: config.fetchFn } : {}),
      }, cache)
      return encoder.encode(xml)
    },
    parse: async (raw) => {
      const xml = decoder.decode(raw)
      const { features } = parseAvinorAirportsGml(xml)
      return features
    },
  }
}

export const __internals = {
  extractMemberBlocks,
  textOf,
  attrOf,
  parsePos,
  validIcao,
  validIata,
  stripXmlComments,
}
