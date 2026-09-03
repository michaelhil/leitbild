import { geoJsonGeometrySchema, type GeoJsonGeometry } from '../../core/model/geo.ts'
import type { PackMapFeature } from '../../core/packs/protocol.ts'
import { longitudeIntervals, type ExternalGeometry, type ExternalRecord, type SituationConfig } from './model.ts'

export const recordItemId = (record: Pick<ExternalRecord, 'id' | 'sourceId'>): string => JSON.stringify([record.sourceId, record.id])
export const splitGeometry = (geometry: ExternalGeometry): GeoJsonGeometry[] => {
  switch (geometry.type) {
    case 'MultiPoint': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'Point', coordinates }))
    case 'MultiLineString': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'LineString', coordinates }))
    case 'MultiPolygon': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'Polygon', coordinates }))
    default: return [geoJsonGeometrySchema.parse(geometry)]
  }
}
export const recordMapFeatures = (record: ExternalRecord): PackMapFeature[] => record.geometry ? splitGeometry(record.geometry).map((geometry, index) => ({
  id: 'situation:' + recordItemId(record) + ':' + index, layerId: 'situation-monitor', categoryId: 'situation-monitor', geometry,
  color: record.kind === 'event' ? '#e8793b' : record.kind === 'forecast' ? '#38bdf8' : '#a78bfa', opacity: .18, lineWidth: 2, lineOpacity: .8,
  summary: record.title + ' · ' + (record.validAt ?? record.publishedAt ?? record.retrievedAt),
  selection: { panelId: 'situation-monitor.records', itemId: recordItemId(record) },
})) : []

export const watchedAreaFeatures = (areas: SituationConfig['areas']): PackMapFeature[] => areas.flatMap(area => longitudeIntervals(area.bounds[0], area.bounds[2]).map(([w,e], index) => ({
  id: 'situation:area:' + area.id + ':' + index, layerId: 'situation-monitor', categoryId: 'situation-monitor',
  geometry: geoJsonGeometrySchema.parse({ type: 'Polygon', coordinates: [[[w,area.bounds[1]],[e,area.bounds[1]],[e,area.bounds[3]],[w,area.bounds[3]],[w,area.bounds[1]]]] }),
  color: '#38bdf8', opacity: 0, lineWidth: 1, lineOpacity: .7, summary: 'Watched area: ' + area.name,
})))

/** Forecast samples share a location; show the nearest valid forecast, not many stacked symbols. */
export const mapRecords = (records: ExternalRecord[], now = Date.now()): ExternalRecord[] => {
  const forecasts = new Map<string, ExternalRecord>()
  const observations: ExternalRecord[] = []
  for (const record of records) {
    if (record.kind !== 'forecast') { observations.push(record); continue }
    const previous = forecasts.get(record.sourceId)
    if (!previous || Math.abs(Date.parse(record.validAt!) - now) < Math.abs(Date.parse(previous.validAt!) - now)) forecasts.set(record.sourceId, record)
  }
  return [...observations, ...forecasts.values()]
}
