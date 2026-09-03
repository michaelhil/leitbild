import { expect, test } from 'bun:test'
import { decodeSource } from './decode.ts'
import { sourceRequestUrl } from './catalog.ts'
import { foldTrafficRecords } from './norway.ts'
import { situationSourceSchema } from '../model.ts'
const now = '2026-09-03T12:00:00.000Z'
const decode = (dataset: string, properties: unknown) => decodeSource(situationSourceSchema.parse({ id: 'norway', name: 'Norway', adapter: 'vegvesen', dataset }), JSON.stringify({ type: 'FeatureCollection', totalFeatures: 1, features: [{ type: 'Feature', id: 'unstable-database-id', geometry: { type: 'Point', coordinates: [10,60] }, properties }] }), now)[0]!
test('camera catalogue uses provider identity and published URLs, including still availability', () => {
  const record = decode('cameras', { cameraId: 'camera-1', description: 'Road camera', stillImageUrl: 'https://example.org/image.jpg', videoUrl: 'https://example.org/live.m3u8', videoEncodingStandard: 'hls', 'status.stillImageAvailability': 'cameraFault', lastUpdateTime: now })
  expect(record.id).toBe('camera-1'); expect(record.media).toHaveLength(2); expect(record.media[0]!.available).toBe(false); expect(record.media[1]!.url).toBe('https://example.org/live.m3u8'); expect(record.observedAt).toBe(now)
  expect(decode('cameras', { cameraId: 'camera-2', videoServiceLevel: 1 }).media).toEqual([])
})
test('road weather preserves zero readings and measurement time without coercing nulls into observations', () => {
  const record = decode('road-weather', { REFERENCE_ID: 'station', LOCATION_DESCRIPTION: 'Station', MEASUREMENT_TIME: now, AIR_TEMPERATURE: 0, WIND_SPEED: 0, ROAD_SURFACE_TEMPERATURE: null })
  expect(record.kind).toBe('observation'); expect(record.subject?.id).toBe('station'); expect(record.observedAt).toBe(now)
  expect(record.measurements).toEqual([{ id: 'air-temperature', value: 0, unit: '°C' }, { id: 'wind-speed', value: 0, unit: 'm/s' }])
})
test('MET warning advice, severity and interval survive ingestion', () => {
  const source = situationSourceSchema.parse({ id: 'warnings', name: 'Warnings', adapter: 'met-alerts' })
  const record = decodeSource(source, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,0]]] }, properties: { id: 'warning', title: 'Gale', description: 'Forecast gale', web: 'https://example.org/warning', severity: 'Moderate', instruction: 'Keep boats in port', consequences: 'High waves' }, when: { interval: [now, '2026-09-04T12:00:00Z'] } }] }), now)[0]!
  expect(record.details.instruction).toBe('Keep boats in port'); expect(record.validFrom).toBe(now); expect(record.severity).toBe('moderate'); expect(record.geometry?.type).toBe('Polygon')
})
test('GeoJSON mapping uses JSON Pointers for arrays and literal dotted keys', () => {
  const source = situationSourceSchema.parse({ id: 'g', name: 'GeoJSON', adapter: 'geojson', url: 'https://example.org/data', mapping: { id: '/properties/record.id', title: '/properties/names/0', time: '/properties/time', url: '/properties/link~1url' } })
  const record = decodeSource(source, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { 'record.id': 'one', names: ['Camera'], 'link/url': 'https://example.org/camera' }, geometry: null }] }), now)[0]!
  expect(record.id).toBe('one'); expect(record.title).toBe('Camera'); expect(record.url).toBe('https://example.org/camera')
})
test('partial provider catalogues are rejected rather than replacing complete evidence', () => {
  const source = situationSourceSchema.parse({ id: 'c', name: 'Cameras', adapter: 'vegvesen', dataset: 'cameras' })
  expect(() => decodeSource(source, JSON.stringify({ type: 'FeatureCollection', totalFeatures: 10, features: [] }), now)).toThrow('truncated')
  expect(new URL(sourceRequestUrl(source)).searchParams.get('typeName')).toBe('datex_3_1:CctvSimple')
})
test('flattened traffic secondary types become one stable record without dropping information', () => {
  const a = decode('traffic', { SITUATION_ID: 'situation', RECORD_ID: 'one', SECONDARY_TYPES: 'narrowLanes', DESCRIPTION: 'Road work', COORDINATES_FOR_DISPLAY_LONGITUDE: 10, COORDINATES_FOR_DISPLAY_LATITUDE: 60 })
  const b = { ...a, details: { ...a.details, type: 'laneClosures' } }
  const [record] = foldTrafficRecords([a,b])
  expect(record!.details.type).toBe('laneClosures, narrowLanes'); expect(record!.geometry?.type).toBe('Point')
  expect(() => foldTrafficRecords([a,{ ...b, summary: 'Conflicting record' }])).toThrow('conflicting')
})
