import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { buildCacheEntry } from '../../../reference-data/fetch-cache.ts'
import {
  asSourceId,
  type DatasetSource,
  type FetchCache,
  type GeoJsonGeometry,
  type GeoJsonPosition,
  type NormalizedFeature,
  type RawBytes,
} from '../../../reference-data/types.ts'
import type { GridReferenceCategory, GridReferenceFeatureProperties } from '../schemas/grid-reference.ts'

export type HttpFetch = (
  url: string,
  init?: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: string
  },
) => Promise<Response>

export interface OverpassBbox {
  readonly south: number
  readonly west: number
  readonly north: number
  readonly east: number
}

export interface OverpassPowerSourceConfig {
  readonly id?: string
  readonly endpointUrl?: string
  readonly bbox: OverpassBbox
  readonly timeoutSeconds?: number
  readonly userAgent?: string
  readonly fetchFn?: HttpFetch
}

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter'
const DEFAULT_USER_AGENT = 'Leitbild/0.1 (https://leitbild.samsinn.app)'

const textEncoder = new TextEncoder()

const tagRecordSchema = z.record(z.union([z.string(), z.number(), z.boolean()])).default({})
const coordinateSchema = z.object({
  lat: z.number().finite(),
  lon: z.number().finite(),
})
const boundsSchema = z.object({
  minlat: z.number().finite(),
  minlon: z.number().finite(),
  maxlat: z.number().finite(),
  maxlon: z.number().finite(),
})
const overpassElementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number().int(),
  lat: z.number().finite().optional(),
  lon: z.number().finite().optional(),
  bounds: boundsSchema.optional(),
  tags: tagRecordSchema,
  geometry: z.array(coordinateSchema).optional(),
})

const overpassResponseSchema = z.object({
  elements: z.array(overpassElementSchema),
  remark: z.string().optional(),
})

type OverpassElement = z.infer<typeof overpassElementSchema>

const numericTag = (tags: Readonly<Record<string, string>>, key: string): number | null => {
  const value = tags[key]
  if (!value) return null
  const first = value.split(';')[0]?.trim()
  if (!first) return null
  const parsed = Number(first.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

const voltageKv = (tags: Readonly<Record<string, string>>): ReadonlyArray<number> => {
  const value = tags.voltage ?? ''
  const parsed = value
    .split(/[;,]/)
    .map(part => Number(part.trim().replace(',', '.')))
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => value >= 1000 ? value / 1000 : value)
  return [...new Set(parsed)].sort((left, right) => right - left)
}

const tagsAsStrings = (tags: Readonly<Record<string, string | number | boolean>>): Record<string, string> =>
  Object.fromEntries(Object.entries(tags).map(([key, value]) => [key, String(value)]))

const categoryForPower = (power: string | undefined): GridReferenceCategory => {
  if (power === 'line' || power === 'minor_line') return 'line'
  if (power === 'cable') return 'cable'
  if (power === 'substation') return 'substation'
  if (power === 'transformer') return 'transformer'
  if (power === 'plant') return 'plant'
  if (power === 'generator') return 'generator'
  return 'unknown'
}

const assetKindForCategory = (
  category: GridReferenceCategory,
): GridReferenceFeatureProperties['assetKind'] => {
  if (category === 'line' || category === 'cable' || category === 'transformer') return 'branch'
  if (category === 'substation') return 'node'
  if (category === 'plant' || category === 'generator') return 'generator'
  if (category === 'load') return 'load'
  return 'unknown'
}

const geometryFromElement = (element: OverpassElement, category: GridReferenceCategory): {
  readonly geometry: GeoJsonGeometry
  readonly geometrySource: GridReferenceFeatureProperties['geometrySource']
  readonly confidencePenalty: boolean
} | null => {
  if (element.type === 'node' && element.lat !== undefined && element.lon !== undefined) {
    return {
      geometry: { type: 'Point', coordinates: [element.lon, element.lat] },
      geometrySource: 'osm-node',
      confidencePenalty: false,
    }
  }
  const coordinates = element.geometry?.map((point): GeoJsonPosition => [point.lon, point.lat]) ?? []
  if (coordinates.length >= 2) {
    const first = coordinates[0]
    const last = coordinates[coordinates.length - 1]
    const closed = first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
    if (closed && (category === 'substation' || category === 'plant')) {
      return {
        geometry: { type: 'Polygon', coordinates: [coordinates] },
        geometrySource: 'osm-geometry',
        confidencePenalty: false,
      }
    }
    return {
      geometry: { type: 'LineString', coordinates },
      geometrySource: 'osm-geometry',
      confidencePenalty: false,
    }
  }
  if (element.bounds) {
    return {
      geometry: {
        type: 'Point',
        coordinates: [
          (element.bounds.minlon + element.bounds.maxlon) / 2,
          (element.bounds.minlat + element.bounds.maxlat) / 2,
        ],
      },
      geometrySource: 'bounds-centroid',
      confidencePenalty: true,
    }
  }
  return null
}

const buildProperties = (
  element: OverpassElement,
  source: string,
  category: GridReferenceCategory,
  geometrySource: GridReferenceFeatureProperties['geometrySource'],
  confidencePenalty: boolean,
): GridReferenceFeatureProperties => {
  const tags = tagsAsStrings(element.tags)
  const voltages = voltageKv(tags)
  const hasKeyElectricalProperties = voltages.length > 0 || tags.frequency !== undefined || tags.output !== undefined || tags['plant:output:electricity'] !== undefined
  return {
    source,
    category,
    assetKind: assetKindForCategory(category),
    externalId: `${element.type}/${element.id}`,
    name: tags.name ?? tags.ref ?? null,
    operator: tags.operator ?? tags.owner ?? null,
    voltageKv: [...voltages],
    frequencyHz: numericTag(tags, 'frequency'),
    circuits: numericTag(tags, 'circuits'),
    cables: numericTag(tags, 'cables'),
    power: tags.power ?? null,
    plantSource: tags['plant:source'] ?? tags['generator:source'] ?? null,
    outputMw: numericTag(tags, 'plant:output:electricity') ?? numericTag(tags, 'generator:output:electricity') ?? numericTag(tags, 'output'),
    geometrySource,
    propertyProvenance: hasKeyElectricalProperties ? 'observed' : 'unknown',
    confidence: confidencePenalty ? 'low' : hasKeyElectricalProperties ? 'high' : 'medium',
    tags,
  }
}

export const normaliseOverpassPowerElements = (
  raw: unknown,
  source = 'osm:overpass-power',
): ReadonlyArray<NormalizedFeature> => {
  const parsed = overpassResponseSchema.parse(raw)
  if (parsed.remark) {
    throw new Error(`overpass-power: server returned remark for ${source} — ${parsed.remark}`)
  }
  return parsed.elements.flatMap((element): ReadonlyArray<NormalizedFeature> => {
    const category = categoryForPower(String(element.tags.power ?? ''))
    if (category === 'unknown') return []
    const geo = geometryFromElement(element, category)
    if (!geo) return []
    return [{
      type: 'Feature',
      id: `${source}:${element.type}:${element.id}`,
      geometry: geo.geometry,
      properties: buildProperties(element, source, category, geo.geometrySource, geo.confidencePenalty),
    }]
  })
}

export const buildOverpassPowerQuery = (config: {
  readonly bbox: OverpassBbox
  readonly timeoutSeconds?: number
}): string => {
  const timeout = config.timeoutSeconds ?? 180
  const bbox = `${config.bbox.south},${config.bbox.west},${config.bbox.north},${config.bbox.east}`
  return [
    `[out:json][timeout:${timeout}];`,
    '(',
    `node["power"~"^(substation|transformer|plant|generator)$"](${bbox});`,
    `way["power"~"^(line|minor_line|cable|substation|transformer|plant|generator)$"](${bbox});`,
    ');',
    'out body geom;',
  ].join('\n')
}

const readCachedBody = async (cache: FetchCache, sourceId: string): Promise<RawBytes | null> => {
  const cached = await cache.read(asSourceId(sourceId))
  if (!cached) return null
  return new Uint8Array(await readFile(cached.path))
}

export const overpassPowerSource = (config: OverpassPowerSourceConfig): DatasetSource => {
  const id = config.id ?? 'osm:overpass-power:NO'
  const endpointUrl = config.endpointUrl ?? DEFAULT_ENDPOINT
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT
  const query = buildOverpassPowerQuery(config)
  const fetchFn: HttpFetch = config.fetchFn ?? ((url, init) => globalThis.fetch(url, init))
  return {
    kind: 'remote',
    id: asSourceId(id),
    fetch: async (cache): Promise<RawBytes> => {
      const response = await fetchFn(endpointUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': userAgent,
        },
        body: new URLSearchParams({ data: query }).toString(),
      })
      if (response.status === 304) {
        const cached = await readCachedBody(cache, id)
        if (!cached) throw new Error(`overpass-power: server returned 304 but no cached body exists for ${id}`)
        return cached
      }
      const body = new Uint8Array(await response.arrayBuffer())
      if (response.status < 200 || response.status >= 300) {
        const excerpt = new TextDecoder().decode(body).slice(0, 300)
        throw new Error(`overpass-power: HTTP ${response.status} for ${id} — ${excerpt}`)
      }
      await cache.write(buildCacheEntry({
        sourceId: asSourceId(id),
        body,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      }), body)
      return body
    },
    parse: async (raw): Promise<ReadonlyArray<NormalizedFeature>> =>
      normaliseOverpassPowerElements(JSON.parse(new TextDecoder().decode(raw)), id),
  }
}

export const parseOverpassFixture = async (path: string): Promise<ReadonlyArray<NormalizedFeature>> => {
  const raw = await readFile(path, 'utf8')
  return normaliseOverpassPowerElements(JSON.parse(raw))
}
