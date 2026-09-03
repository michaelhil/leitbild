import { externalRecordSchema, type ExternalRecord, type SituationSource } from '../model.ts'
import { geometry, object, plain, text, timestamp, stableId } from './values.ts'

type NorwegianSource = Extract<SituationSource, { adapter: 'met-alerts' | 'vegvesen' }>
const requiredId = (value: unknown): string => { const id = text(value); if (!id) throw new Error('Provider record has no stable identity'); return id }
const severity = (value: unknown): ExternalRecord['severity'] => {
  const levels: Readonly<Record<string, ExternalRecord['severity']>> = { Minor: 'minor', Moderate: 'moderate', Severe: 'severe', Extreme: 'extreme', highest: 'severe', high: 'moderate', medium: 'minor', low: 'info' }
  return levels[text(value)]
}
const weatherFields = [
  ['AIR_TEMPERATURE', 'air-temperature', '°C'], ['ROAD_SURFACE_TEMPERATURE', 'road-surface-temperature', '°C'],
  ['WIND_SPEED', 'wind-speed', 'm/s'], ['MAXIMUM_WIND_SPEED', 'wind-gust', 'm/s'], ['WIND_DIRECTION_BEARING', 'wind-direction', '°'],
  ['RELATIVE_HUMIDITY', 'relative-humidity', '%'], ['DEW_POINT_TEMPERATURE', 'dew-point', '°C'],
  ['PRECIPITATION_INTENSITY', 'precipitation-intensity', 'mm/h'], ['DEPTH_OF_SNOW', 'snow-depth', 'cm'], ['MINIMUM_VISIBILITY_DISTANCE', 'visibility', 'm'],
] as const

/** Small semantic decoders preserve what the generic GeoJSON adapter cannot infer. No assets or media URLs are invented. */
export const decodeNorwegianFeature = (source: NorwegianSource, feature: Record<string, unknown>, base: Pick<ExternalRecord, 'sourceId' | 'attribution' | 'retrievedAt'>, requestUrl: string): ExternalRecord => {
  const p = object(feature.properties), geo = geometry(feature.geometry)
  if (source.adapter === 'met-alerts') {
    const interval = object(feature.when).interval
    return externalRecordSchema.parse({ ...base, id: requiredId(p.id), kind: 'event', title: plain(p.title, 500), summary: plain(p.description, 3000),
      url: text(p.web) || requestUrl, geometry: geo, category: text(p.event), severity: severity(p.severity),
      validFrom: timestamp(Array.isArray(interval) ? interval[0] : undefined), validUntil: timestamp(Array.isArray(interval) ? interval[1] : p.eventEndingTime),
      details: { area: text(p.area), consequences: text(p.consequences), instruction: text(p.instruction), certainty: text(p.certainty), status: text(p.status), providerSeverity: text(p.severity), domain: text(p.geographicDomain) },
    })
  }
  if (source.dataset === 'cameras') {
    const id = requiredId(p.cameraId), title = plain(p.description, 500) || id
    const available = p['status.stillImageAvailability'] === 'videoOrImagesAvailable'
    return externalRecordSchema.parse({ ...base, id, kind: 'media', title, url: text(p.stillImageUrlDescription) || requestUrl, geometry: geo,
      subject: { id, label: title }, category: 'camera', observedAt: timestamp(p.lastUpdateTime), publishedAt: timestamp(p.publicationTime),
      summary: [text(p.roadNumber), text(p.orientationDescription)].filter(Boolean).join(' · '),
      details: { availability: text(p['status.stillImageAvailability']), road: text(p.roadNumber), direction: text(p.orientationDescription) },
      media: [
        ...(text(p.stillImageUrl) ? [{ format: 'image', url: text(p.stillImageUrl), available, label: 'Latest provider image' }] : []),
        ...(p.videoEncodingStandard === 'hls' && text(p.videoUrl) ? [{ format: 'hls', url: text(p.videoUrl), label: 'Live camera stream' }] : []),
      ],
    })
  }
  if (source.dataset === 'road-weather') {
    const id = requiredId(p.REFERENCE_ID), title = plain(p.LOCATION_DESCRIPTION, 500) || id
    return externalRecordSchema.parse({ ...base, id, kind: 'observation', title, url: requestUrl, geometry: geo, subject: { id, label: title }, category: 'road-weather',
      observedAt: timestamp(p.MEASUREMENT_TIME), publishedAt: timestamp(p.publicationTime),
      summary: [text(p.ROAD_NUMBER), text(p.COUNTY)].filter(Boolean).join(' · '),
      measurements: weatherFields.flatMap(([field, measurementId, unit]) => typeof p[field] === 'number' && Number.isFinite(p[field]) ? [{ id: measurementId, value: p[field], unit }] : []),
    })
  }
  const displayPoint = typeof p.COORDINATES_FOR_DISPLAY_LONGITUDE === 'number' && typeof p.COORDINATES_FOR_DISPLAY_LATITUDE === 'number'
    ? { type: 'Point', coordinates: [p.COORDINATES_FOR_DISPLAY_LONGITUDE, p.COORDINATES_FOR_DISPLAY_LATITUDE] } : undefined
  return externalRecordSchema.parse({ ...base, id: stableId(JSON.stringify([requiredId(p.SITUATION_ID), requiredId(p.RECORD_ID)])), kind: 'event', title: plain(p.LOCATION_DESCRIPTION, 500) || text(p.ROAD_NUMBER),
    url: requestUrl, geometry: displayPoint, category: text(p.SITUATION_TYPE), severity: severity(p.SEVERITY), summary: plain(p.DESCRIPTION, 3000),
    publishedAt: timestamp(p.CREATION_DATE), updatedAt: timestamp(p.LAST_UPDATE_TIME), validFrom: timestamp(p.START_TIME), validUntil: timestamp(p.END_TIME),
    details: { description: text(p.DESCRIPTION), road: text(p.ROAD_NUMBER), type: text(p.SECONDARY_TYPES), status: p.ACTIVE === 1 ? 'active' : 'scheduled or inactive', providerSeverity: text(p.SEVERITY), situationId: text(p.SITUATION_ID), periods: text(p.NUM_PERIODS), mapRepresentation: 'Provider display location, not the complete affected road geometry.' },
  })
}

/** WFS flattens a DATEX record's multiple secondary types into separate rows. Preserve all types on one record. */
export const foldTrafficRecords = (rows: ExternalRecord[]): ExternalRecord[] => {
  const records = new Map<string, { record: ExternalRecord; types: Set<string> }>()
  for (const record of rows) {
    const { type = '', ...details } = record.details
    const canonical = { ...record, details }, existing = records.get(record.id)
    if (!existing) records.set(record.id, { record: canonical, types: new Set([type]) })
    else {
      if (JSON.stringify(existing.record) !== JSON.stringify(canonical)) throw new Error('Provider has conflicting traffic rows for record ' + record.id)
      existing.types.add(type)
    }
  }
  return [...records.values()].map(({ record, types }) => externalRecordSchema.parse({ ...record, details: { ...record.details, type: [...types].filter(Boolean).sort().join(', ') } }))
}
