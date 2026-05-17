import { z } from 'zod'

export const mapTilesetId = 'leitbild-osm-norway'
export const mapTilesetSchemaVersion = 1

export const mapCapabilityFieldAvailabilitySchema = z.enum(['required', 'optional'])
export type MapCapabilityFieldAvailability = z.infer<typeof mapCapabilityFieldAvailabilitySchema>

export const mapCapabilityFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  availability: mapCapabilityFieldAvailabilitySchema,
  values: z.array(z.string().min(1)).optional(),
  description: z.string().min(1),
})
export type MapCapabilityField = z.infer<typeof mapCapabilityFieldSchema>

export const mapCapabilityLayerSchema = z.object({
  id: z.string().min(1),
  sourceLayer: z.string().min(1),
  geometry: z.array(z.enum(['point', 'line', 'polygon'])).min(1),
  category: z.enum(['road_semantics', 'operational_poi', 'risk_context', 'mobility_constraint', 'base_context']),
  intendedUse: z.string().min(1),
  fields: z.array(mapCapabilityFieldSchema),
})
export type MapCapabilityLayer = z.infer<typeof mapCapabilityLayerSchema>

export const mapCapabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  tilesetId: z.literal(mapTilesetId),
  region: z.object({
    id: z.literal('norway'),
    source: z.literal('geofabrik'),
    sourceUrl: z.string().url(),
  }),
  artifact: z.object({
    format: z.literal('pmtiles'),
    tileEncoding: z.literal('mvt'),
    currentTileUrl: z.literal('/map/tiles/current.pmtiles'),
    styleUrl: z.literal('/map/style.json'),
    glyphsUrl: z.literal('/map/fonts/{fontstack}/{range}.pbf'),
  }),
  schema: z.object({
    name: z.literal('openmaptiles-compatible-leitbild-v1'),
    generatedBy: z.literal('planetiler-openmaptiles'),
    evolution: z.literal('breaking changes increment schemaVersion; no backward compatibility is preserved'),
  }),
  layers: z.array(mapCapabilityLayerSchema).min(1),
})
export type MapCapabilityManifest = z.infer<typeof mapCapabilityManifestSchema>

const roadClassValues = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'track',
  'path',
  'rail',
  'ferry',
]

const poiClassValues = [
  'hospital',
  'fire_station',
  'police',
  'doctors',
  'pharmacy',
  'helipad',
  'airport',
  'port',
  'fuel',
  'charging_station',
]

export const createMapCapabilityManifest = (): MapCapabilityManifest => mapCapabilityManifestSchema.parse({
  schemaVersion: mapTilesetSchemaVersion,
  tilesetId: mapTilesetId,
  region: {
    id: 'norway',
    source: 'geofabrik',
    sourceUrl: 'https://download.geofabrik.de/europe/norway-latest.osm.pbf',
  },
  artifact: {
    format: 'pmtiles',
    tileEncoding: 'mvt',
    currentTileUrl: '/map/tiles/current.pmtiles',
    styleUrl: '/map/style.json',
    glyphsUrl: '/map/fonts/{fontstack}/{range}.pbf',
  },
  schema: {
    name: 'openmaptiles-compatible-leitbild-v1',
    generatedBy: 'planetiler-openmaptiles',
    evolution: 'breaking changes increment schemaVersion; no backward compatibility is preserved',
  },
  layers: [
    {
      id: 'transportation',
      sourceLayer: 'transportation',
      geometry: ['line', 'polygon'],
      category: 'road_semantics',
      intendedUse: 'Road hierarchy, route context, surface-level mobility interpretation, and control-center visual road emphasis.',
      fields: [
        { name: 'class', type: 'string', availability: 'required', values: roadClassValues, description: 'Normalized road or transportation class.' },
        { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific OSM-derived transportation subtype when emitted by the profile.' },
        { name: 'brunnel', type: 'string', availability: 'optional', values: ['bridge', 'tunnel', 'ford'], description: 'Bridge/tunnel/ford context where the profile emits it.' },
        { name: 'oneway', type: 'boolean', availability: 'optional', description: 'One-way direction hint where available.' },
        { name: 'ramp', type: 'boolean', availability: 'optional', description: 'Ramp hint where available.' },
        { name: 'service', type: 'string', availability: 'optional', description: 'Service road subtype where available.' },
        { name: 'access', type: 'string', availability: 'optional', description: 'Access restriction hint where available.' },
        { name: 'maxspeed', type: 'number', availability: 'optional', description: 'Speed-limit hint where available; routing engines remain authoritative for routing.' },
      ],
    },
    {
      id: 'transportation_name',
      sourceLayer: 'transportation_name',
      geometry: ['line'],
      category: 'road_semantics',
      intendedUse: 'Road labeling and operator orientation.',
      fields: [
        { name: 'name', type: 'string', availability: 'optional', description: 'Displayed road name.' },
        { name: 'class', type: 'string', availability: 'optional', values: roadClassValues, description: 'Road class associated with the label feature.' },
      ],
    },
    {
      id: 'poi',
      sourceLayer: 'poi',
      geometry: ['point'],
      category: 'operational_poi',
      intendedUse: 'Static map context for emergency, transport, and infrastructure POIs. These are not canonical Leitbild operational objects.',
      fields: [
        { name: 'class', type: 'string', availability: 'required', values: poiClassValues, description: 'Normalized point-of-interest class.' },
        { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific OSM-derived POI subtype.' },
        { name: 'name', type: 'string', availability: 'optional', description: 'POI label.' },
      ],
    },
    {
      id: 'landuse',
      sourceLayer: 'landuse',
      geometry: ['polygon'],
      category: 'risk_context',
      intendedUse: 'Urban, industrial, commercial, residential, and other land-use context useful for scenarios and risk interpretation.',
      fields: [
        { name: 'class', type: 'string', availability: 'required', description: 'Normalized land-use class.' },
      ],
    },
    {
      id: 'landcover',
      sourceLayer: 'landcover',
      geometry: ['polygon'],
      category: 'risk_context',
      intendedUse: 'Natural context such as wood, grass, wetland, rock, or sand for scenario interpretation and map readability.',
      fields: [
        { name: 'class', type: 'string', availability: 'required', values: ['wood', 'grass', 'wetland', 'rock', 'sand', 'farmland', 'ice'], description: 'Normalized land-cover class.' },
        { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific land-cover subtype.' },
      ],
    },
    {
      id: 'water',
      sourceLayer: 'water',
      geometry: ['polygon'],
      category: 'risk_context',
      intendedUse: 'Water polygons for situational awareness, route context, and scenario constraints.',
      fields: [
        { name: 'class', type: 'string', availability: 'optional', description: 'Water class where available.' },
      ],
    },
    {
      id: 'waterway',
      sourceLayer: 'waterway',
      geometry: ['line'],
      category: 'risk_context',
      intendedUse: 'Rivers, streams, canals, and drainage lines as scenario context.',
      fields: [
        { name: 'class', type: 'string', availability: 'optional', description: 'Waterway class where available.' },
      ],
    },
    {
      id: 'building',
      sourceLayer: 'building',
      geometry: ['polygon'],
      category: 'base_context',
      intendedUse: 'Building footprints for dense urban orientation and future 2.5D context.',
      fields: [
        { name: 'render_height', type: 'number', availability: 'optional', description: 'Approximate render height when emitted by the profile.' },
        { name: 'render_min_height', type: 'number', availability: 'optional', description: 'Approximate minimum render height when emitted by the profile.' },
      ],
    },
    {
      id: 'aeroway',
      sourceLayer: 'aeroway',
      geometry: ['line', 'polygon'],
      category: 'mobility_constraint',
      intendedUse: 'Airfield and runway context for helicopter, drone, aircraft, and emergency-response scenarios.',
      fields: [
        { name: 'class', type: 'string', availability: 'required', description: 'Aeroway class.' },
      ],
    },
    {
      id: 'boundary',
      sourceLayer: 'boundary',
      geometry: ['line'],
      category: 'base_context',
      intendedUse: 'Administrative boundaries for jurisdiction and scenario region context.',
      fields: [
        { name: 'admin_level', type: 'number', availability: 'optional', description: 'OSM administrative level where available.' },
        { name: 'maritime', type: 'boolean', availability: 'optional', description: 'Maritime boundary hint where available.' },
      ],
    },
  ],
})
