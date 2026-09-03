import { geoJsonGeometrySchema, type GeoJsonGeometry } from '../../core/model/geo.ts'
import type { PackMapFeature } from '../../core/packs/protocol.ts'
import { longitudeIntervals, type ExternalGeometry, type ExternalRecord, type SituationConfig, type SituationSource } from './model.ts'

export const recordAppearance = (record: Pick<ExternalRecord, 'kind' | 'category' | 'severity'>, source?: SituationSource) => {
  const icon = source?.map.icon ?? (record.category === 'camera' ? 'cctv' : record.category === 'road-weather' ? 'thermometer' : source?.adapter === 'vegvesen' ? 'construction' : record.kind === 'forecast' ? 'cloud-sun' : record.kind === 'event' ? 'triangle-alert' : record.kind === 'media' ? 'video' : record.kind === 'report' ? 'newspaper' : 'map-pin')
  const severityColor = record.severity && ({ info: '#38bdf8', minor: '#facc15', moderate: '#fb923c', severe: '#ef4444', extreme: '#c026d3' } as const)[record.severity]
  return { icon, color: source?.map.color ?? severityColor ?? (record.kind === 'media' ? '#8b5cf6' : record.kind === 'observation' ? '#06b6d4' : record.kind === 'forecast' ? '#38bdf8' : record.kind === 'event' ? '#f59e0b' : '#64748b') }
}

export const recordItemId = (record: Pick<ExternalRecord, 'id' | 'sourceId'>): string => JSON.stringify([record.sourceId, record.id])
export const splitGeometry = (geometry: ExternalGeometry): GeoJsonGeometry[] => {
  switch (geometry.type) {
    case 'MultiPoint': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'Point', coordinates }))
    case 'MultiLineString': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'LineString', coordinates }))
    case 'MultiPolygon': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'Polygon', coordinates }))
    default: return [geoJsonGeometrySchema.parse(geometry)]
  }
}
export const recordMapFeatures = (record: ExternalRecord, source?: SituationSource): PackMapFeature[] => record.geometry ? splitGeometry(record.geometry).map((geometry, index) => ({
  id: 'situation:' + recordItemId(record) + ':' + index, layerId: 'situation-monitor', categoryId: 'situation-monitor', geometry,
  color: recordAppearance(record, source).color, symbol: { icon: recordAppearance(record, source).icon }, opacity: source?.map.opacity ?? .18, lineWidth: source?.map.lineWidth ?? 2, lineOpacity: .8,
  summary: record.title + ' · ' + (record.validAt ?? record.publishedAt ?? record.retrievedAt),
  selection: { panelId: 'situation-monitor.records', itemId: recordItemId(record) },
})) : []

export const watchedAreaFeatures = (areas: SituationConfig['areas']): PackMapFeature[] => areas.flatMap(area => longitudeIntervals(area.bounds[0], area.bounds[2]).map(([w,e], index) => ({
  id: 'situation:area:' + area.id + ':' + index, layerId: 'situation-monitor', categoryId: 'situation-monitor',
  geometry: geoJsonGeometrySchema.parse({ type: 'Polygon', coordinates: [[[w,area.bounds[1]],[e,area.bounds[1]],[e,area.bounds[3]],[w,area.bounds[3]],[w,area.bounds[1]]]] }),
  color: '#38bdf8', opacity: 0, lineWidth: 1, lineOpacity: .7, summary: 'Watched area: ' + area.name,
})))
