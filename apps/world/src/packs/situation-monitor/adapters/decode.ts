import { createHash } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { externalGeometrySchema, externalRecordSchema, type ExternalRecord, type SituationSource } from '../model.ts'
import { sourceRequestUrl } from './catalog.ts'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : typeof object(value)['#text'] === 'string' ? object(value)['#text'] as string : ''
const plain = (value: unknown, max: number): string => text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const atPath = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((item, part) => Object.hasOwn(object(item), part) ? object(item)[part] : undefined, value)
const timestamp = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const date = typeof value === 'number' ? new Date(value) : new Date(text(value))
  if (!Number.isFinite(date.getTime())) throw new Error('Source has an invalid timestamp')
  return date.toISOString()
}
const stableId = (value: string): string => value.length <= 180 ? value : createHash('sha256').update(value).digest('hex')
const identity = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32)
const coordinates2D = (value: unknown): unknown => Array.isArray(value) ? typeof value[0] === 'number' ? value.slice(0, 2) : value.map(coordinates2D) : value
const geometry = (value: unknown) => value === null || value === undefined ? undefined : externalGeometrySchema.parse({ type: object(value).type, coordinates: coordinates2D(object(value).coordinates) })
const linkedUrl = (value: unknown, base: string): string => {
  const candidate = text(value)
  return candidate ? new URL(candidate, base).href : base
}

export const decodeSource = (source: SituationSource, body: string, retrievedAt: string): ExternalRecord[] => {
  const requestUrl = sourceRequestUrl(source)
  const base = { sourceId: source.id, attribution: source.attribution || new URL(requestUrl).hostname, retrievedAt }
  if (source.adapter === 'media') return [externalRecordSchema.parse({ ...base, id: source.id + ':media', kind: 'media', title: source.name, url: source.url, media: { format: source.format, url: source.url }, ...(source.point ? { geometry: { type: 'Point', coordinates: source.point } } : {}) })]
  if (source.adapter === 'rss') {
    if (/<!DOCTYPE|<!ENTITY/i.test(body.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, ''))) throw new Error('XML declarations with document types or entities are not accepted')
    if ((body.match(/</g)?.length ?? 0) > 100000) throw new Error('XML feed contains too many elements')
    const validation = XMLValidator.validate(body)
    if (validation !== true) throw new Error('Malformed XML feed: ' + validation.err.msg)
    const parsed = object(new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true, removeNSPrefix: true, maxNestedTags: 64 }).parse(body))
    const channel = object(object(parsed.rss).channel)
    const feed = object(parsed.feed)
    if (!parsed.rss && !parsed.feed) throw new Error('Expected an RSS or Atom feed, not a web page')
    const items = array(parsed.rss ? channel.item : feed.entry)
    if (items.length > 5000) throw new Error('Feed exceeds 5,000 records; choose a smaller feed window')
    return items.map(raw => {
      const item = object(raw)
      const link = array(item.link).find(value => typeof value === 'string' || !object(value)['@_rel'] || object(value)['@_rel'] === 'alternate')
      const url = linkedUrl(typeof link === 'string' ? link : object(link)['@_href'], requestUrl)
      const title = plain(item.title, 500)
      const upstream = text(item.guid || item.id) || identity(url + '\n' + title)
      return externalRecordSchema.parse({ ...base, id: stableId(upstream), kind: 'report', title, url, summary: plain(item.description || item.summary || item.content, 3000), publishedAt: timestamp(item.pubDate || item.published || item.updated), updatedAt: timestamp(item.updated) })
    })
  }
  const parsed = object(JSON.parse(body) as unknown)
  if (source.adapter === 'met-forecast') {
    const properties = object(parsed.properties), metadata = object(properties.meta), units = object(metadata.units)
    if (!Array.isArray(properties.timeseries)) throw new Error('Forecast response has no timeseries')
    if (properties.timeseries.length > 2000) throw new Error('Forecast exceeds 2,000 samples')
    const updatedAt = timestamp(metadata.updated_at)
    return properties.timeseries.map(raw => {
      const row = object(raw), validAt = timestamp(row.time), data = object(row.data), details = object(object(data.instant).details)
      if (!validAt) throw new Error('Forecast sample has no valid time')
      const measurements = Object.entries(details).map(([id, value]) => ({ id, value, unit: text(units[id]) || 'unspecified' }))
      return externalRecordSchema.parse({ ...base, id: validAt, kind: 'forecast', title: source.name, summary: 'Provider forecast, not a measurement or simulated condition.', url: requestUrl, publishedAt: updatedAt, updatedAt, validAt, geometry: { type: 'Point', coordinates: source.point }, measurements })
    })
  }
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error('Expected a GeoJSON FeatureCollection')
  if (parsed.features.length > 10000) throw new Error('GeoJSON exceeds 10,000 features; configure a bounded endpoint')
  return parsed.features.map(raw => {
    const feature = object(raw), props = object(feature.properties)
    if (feature.type !== 'Feature') throw new Error('Invalid GeoJSON feature')
    const geo = geometry(feature.geometry)
    if (source.adapter === 'usgs') {
      if (!text(feature.id)) throw new Error('Earthquake record has no upstream ID')
      const coordinates = object(feature.geometry).coordinates
      const measurements = [typeof props.mag === 'number' ? { id: 'magnitude', value: props.mag, unit: text(props.magType) || 'unspecified' } : null, Array.isArray(coordinates) && typeof coordinates[2] === 'number' ? { id: 'depth', value: coordinates[2], unit: 'km' } : null].filter(value => value !== null)
      return externalRecordSchema.parse({ ...base, id: stableId(text(feature.id)), kind: 'event', title: plain(props.title || props.place, 500), summary: plain(props.status, 3000), url: linkedUrl(props.url, requestUrl), publishedAt: timestamp(props.time), updatedAt: timestamp(props.updated), geometry: geo, measurements })
    }
    const title = plain(atPath(feature, source.mapping.title), 500)
    const url = linkedUrl(atPath(feature, source.mapping.url), requestUrl)
    const id = text(atPath(feature, source.mapping.id))
    if (!id) throw new Error('GeoJSON record has no ID at configured path: ' + source.mapping.id)
    return externalRecordSchema.parse({ ...base, id: stableId(id), kind: 'feature', title: title || id, url, publishedAt: timestamp(atPath(feature, source.mapping.time)), geometry: geo })
  })
}
