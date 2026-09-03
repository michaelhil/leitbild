import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { externalRecordSchema, type ExternalRecord, type SituationSource } from '../model.ts'
import { sourceRequestUrl } from './catalog.ts'

import { object, array, text, plain, atPath, timestamp, stableId, identity, geometry, linkedUrl } from './values.ts'
import { decodeNorwegianFeature, foldTrafficRecords } from './norway.ts'

export const decodeSource = (source: SituationSource, body: string, retrievedAt: string): ExternalRecord[] => {
  const requestUrl = sourceRequestUrl(source)
  const base = { sourceId: source.id, attribution: source.attribution || new URL(requestUrl).hostname, retrievedAt }
  if (source.adapter === 'media') return [externalRecordSchema.parse({ ...base, id: identity(source.url), kind: 'media', title: source.name, url: source.url, media: [{ format: source.format, url: source.url }], ...(source.point ? { geometry: { type: 'Point', coordinates: source.point } } : {}) })]
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
      const intervals: Record<string, string> = {}
      for (const window of ['next_1_hours', 'next_6_hours', 'next_12_hours']) {
        const period = object(data[window]), symbol = text(object(period.summary).symbol_code)
        if (symbol) intervals[window] = symbol
        for (const [id, value] of Object.entries(object(period.details))) measurements.push({ id: window + '.' + id, value, unit: text(units[id]) || 'unspecified' })
      }
      return externalRecordSchema.parse({ ...base, id: validAt, kind: 'forecast', title: source.name, summary: 'Provider forecast, not a measurement or simulated condition. next_N_hours quantities describe intervals beginning at the valid time.', url: requestUrl, publishedAt: updatedAt, updatedAt, validAt, subject: { id: source.point.join(','), label: source.name }, geometry: { type: 'Point', coordinates: source.point }, measurements, details: intervals })
    })
  }
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error('Expected a GeoJSON FeatureCollection')
  if (parsed.features.length > 10000) throw new Error('GeoJSON exceeds 10,000 features; configure a bounded endpoint')
  const total = parsed.numberMatched ?? parsed.totalFeatures
  if (typeof total === 'number' && total > parsed.features.length) throw new Error('Provider catalogue was truncated; narrow the source bounds or choose a smaller endpoint')
  const records = parsed.features.map(raw => {
    const feature = object(raw), props = object(feature.properties)
    if (feature.type !== 'Feature') throw new Error('Invalid GeoJSON feature')
    const geo = geometry(feature.geometry)
    if (source.adapter === 'met-alerts' || source.adapter === 'vegvesen') return decodeNorwegianFeature(source, feature, base, requestUrl)
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
  return source.adapter === 'vegvesen' && source.dataset === 'traffic' ? foldTrafficRecords(records) : records
}
