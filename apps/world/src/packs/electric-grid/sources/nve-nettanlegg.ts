import { readFile } from 'node:fs/promises'
import { buildCacheEntry, conditionalGetHeaders } from '../../../reference-data/fetch-cache.ts'
import { asSourceId, type DatasetSource, type FetchCache, type GeoJsonGeometry, type NormalizedFeature, type RawBytes } from '../../../reference-data/types.ts'
import type { GridReferenceFeatureProperties } from '../schemas/grid-reference.ts'

export type HttpFetch = (
  url: string,
  init?: { readonly method?: string; readonly headers?: Record<string, string> },
) => Promise<Response>

export interface NveNettanleggLayerConfig {
  readonly id: number
  readonly category: 'line' | 'cable' | 'substation'
  readonly label: string
}

export interface NveNettanleggSourceConfig {
  readonly id?: string
  readonly endpointUrl?: string
  readonly layers?: ReadonlyArray<NveNettanleggLayerConfig>
  readonly pageSize?: number
  readonly fetchFn?: HttpFetch
}

const defaultEndpoint = 'https://kart.nve.no/enterprise/rest/services/Nettanlegg4/MapServer'

export const nveNettanleggLayers: ReadonlyArray<NveNettanleggLayerConfig> = [
  { id: 0, category: 'line', label: 'Transmisjonsnett luftledning' },
  { id: 1, category: 'line', label: 'Regionalnett luftledning' },
  { id: 3, category: 'cable', label: 'Sjokabler' },
  { id: 5, category: 'substation', label: 'Transformatorstasjoner' },
]

interface ArcGisFeatureCollection {
  readonly type: 'FeatureCollection'
  readonly features: ReadonlyArray<{
    readonly id?: string | number
    readonly geometry: GeoJsonGeometry
    readonly properties: Readonly<Record<string, unknown>>
  }>
}

const encoder = new TextEncoder()

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const numberValue = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const buildQueryUrl = (config: {
  readonly endpointUrl: string
  readonly layerId: number
  readonly offset: number
  readonly pageSize: number
}): string => {
  const url = new URL(`${config.endpointUrl.replace(/\/$/, '')}/${config.layerId}/query`)
  url.searchParams.set('where', '1=1')
  url.searchParams.set('outFields', '*')
  url.searchParams.set('returnGeometry', 'true')
  url.searchParams.set('outSR', '4326')
  url.searchParams.set('f', 'geojson')
  url.searchParams.set('resultOffset', String(config.offset))
  url.searchParams.set('resultRecordCount', String(config.pageSize))
  return url.toString()
}

const fetchText = async (
  config: {
    readonly url: string
    readonly sourceId: string
    readonly cache: FetchCache
    readonly fetchFn: HttpFetch
  },
): Promise<string> => {
  const sourceId = asSourceId(config.sourceId)
  const cached = await config.cache.read(sourceId)
  const response = await config.fetchFn(config.url, {
    method: 'GET',
    headers: {
      accept: 'application/geo+json, application/json',
      ...conditionalGetHeaders(cached),
    },
  })
  if (response.status === 304) {
    if (!cached) throw new Error(`nve-nettanlegg: server returned 304 without a cached body for ${config.url}`)
    return await readFile(cached.path, 'utf8')
  }
  const body = await response.text()
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`nve-nettanlegg: HTTP ${response.status} for ${config.url} — ${body.slice(0, 300)}`)
  }
  const bytes: RawBytes = encoder.encode(body)
  await config.cache.write(buildCacheEntry({
    sourceId,
    body: bytes,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  }), bytes)
  return body
}

const parseVoltageKv = (value: unknown): ReadonlyArray<number> => {
  const number = numberValue(value)
  return number !== null && number > 0 ? [number] : []
}

const propertiesFor = (config: {
  readonly sourceId: string
  readonly layer: NveNettanleggLayerConfig
  readonly feature: ArcGisFeatureCollection['features'][number]
  readonly featureIndex: number
}): GridReferenceFeatureProperties => {
  const props = config.feature.properties
  const voltageKv = parseVoltageKv(props.spenning_kv)
  const name = stringValue(props.navn)
  const operator = stringValue(props.eier)
  const nveId = String(props.nvenetbasid ?? props.objectid ?? config.feature.id ?? `feature-${config.featureIndex}`)
  const hasElectricalProperties = voltageKv.length > 0 || name !== null || operator !== null
  return {
    source: config.sourceId,
    category: config.layer.category,
    assetKind: config.layer.category === 'substation' ? 'node' : 'branch',
    externalId: `nve:${config.layer.id}/${nveId}`,
    name,
    operator,
    voltageKv: [...voltageKv],
    maxVoltageKv: voltageKv.length === 0 ? null : Math.max(...voltageKv),
    frequencyHz: 50,
    circuits: null,
    cables: null,
    power: config.layer.category === 'substation' ? 'substation' : config.layer.category,
    plantSource: null,
    outputMw: null,
    geometrySource: 'source-geometry',
    propertyProvenance: hasElectricalProperties ? 'observed' : 'unknown',
    confidence: hasElectricalProperties ? 'high' : 'medium',
    tags: {
      'nve:layer': config.layer.label,
      ...(name === null ? {} : { name }),
      ...(operator === null ? {} : { operator }),
      ...(props.nvenettnivaa === undefined ? {} : { 'nve:nettnivaa': String(props.nvenettnivaa) }),
      ...(props.sosinettnivaa === undefined ? {} : { 'nve:sosinettnivaa': String(props.sosinettnivaa) }),
      ...(props.driftsattaar === undefined ? {} : { 'nve:driftsattaar': String(props.driftsattaar) }),
      ...(props.spenning_kv === undefined ? {} : { voltage: String(props.spenning_kv) }),
    },
  }
}

export const normaliseNveNettanleggFeatures = (
  collection: ArcGisFeatureCollection,
  config: {
    readonly sourceId?: string
    readonly layer: NveNettanleggLayerConfig
  },
): ReadonlyArray<NormalizedFeature> => {
  const sourceId = config.sourceId ?? 'nve:nettanlegg4'
  return collection.features.map((feature, featureIndex): NormalizedFeature => {
    const featureId = String(feature.id ?? feature.properties.objectid ?? feature.properties.nvenetbasid ?? `feature-${featureIndex}`)
    return {
      type: 'Feature',
      id: `${sourceId}:${config.layer.id}:${featureId}`,
      geometry: feature.geometry,
      properties: propertiesFor({ sourceId, layer: config.layer, feature, featureIndex }),
    }
  })
}

const loadLayer = async (config: {
  readonly sourceId: string
  readonly endpointUrl: string
  readonly layer: NveNettanleggLayerConfig
  readonly pageSize: number
  readonly cache: FetchCache
  readonly fetchFn: HttpFetch
}): Promise<ReadonlyArray<NormalizedFeature>> => {
  const features: NormalizedFeature[] = []
  for (let offset = 0; offset < 100_000; offset += config.pageSize) {
    const url = buildQueryUrl({
      endpointUrl: config.endpointUrl,
      layerId: config.layer.id,
      offset,
      pageSize: config.pageSize,
    })
    const body = await fetchText({
      url,
      sourceId: `${config.sourceId}:layer-${config.layer.id}:offset-${offset}`,
      cache: config.cache,
      fetchFn: config.fetchFn,
    })
    const collection = JSON.parse(body) as ArcGisFeatureCollection
    const batch = normaliseNveNettanleggFeatures(collection, { sourceId: config.sourceId, layer: config.layer })
    features.push(...batch)
    if (batch.length < config.pageSize) return features
  }
  throw new Error(`nve-nettanlegg: pagination did not terminate for layer ${config.layer.id}`)
}

export const nveNettanleggSource = (config: NveNettanleggSourceConfig = {}): DatasetSource => {
  const sourceId = config.id ?? 'nve:nettanlegg4'
  const endpointUrl = config.endpointUrl ?? defaultEndpoint
  const layers = config.layers ?? nveNettanleggLayers
  const pageSize = config.pageSize ?? 2000
  const fetchFn: HttpFetch = config.fetchFn ?? ((url, init) => globalThis.fetch(url, init))
  return {
    kind: 'local',
    id: asSourceId(sourceId),
    load: async (cache): Promise<ReadonlyArray<NormalizedFeature>> => {
      const batches = await Promise.all(layers.map(layer => loadLayer({
        sourceId,
        endpointUrl,
        layer,
        pageSize,
        cache,
        fetchFn,
      })))
      return batches.flat()
    },
  }
}

export const __internals = {
  buildQueryUrl,
  parseVoltageKv,
}
