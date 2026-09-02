import { composeAttributionFromManifest } from './reference-attribution.ts'

// Manifest-driven MapLibre source + layer factory for reference datasets.
// Pure: no MapLibre instance, no side effects. The imperative wiring in
// OperationalMap calls this and applies the result via map.addSource /
// map.addLayer / map.setLayoutProperty for visibility.

export interface DatasetStyleModule {
  readonly outputLayer: string
  readonly fillFor: (category: string) => Record<string, unknown>
  readonly lineFor: (category: string) => Record<string, unknown>
  readonly pointFor?: (category: string) => { readonly paint: Record<string, unknown> } | null
  readonly labelFor?: (category: string) => {
    readonly layout: Record<string, unknown>
    readonly paint: Record<string, unknown>
  } | null
  readonly labelMinZoomFor?: (category: string, categoryMinZoom: number) => number
}

export interface DatasetManifestForLayers {
  readonly datasetId: string
  readonly artifact: {
    readonly pmtilesPath: string
    readonly sidecarGeoJsonPath: string
    readonly outputLayer: string
  }
  readonly categories: ReadonlyArray<{
    readonly category: string
    readonly minZoom: number
    readonly maxZoom: number
    readonly featureCount: number
  }>
  readonly licences: ReadonlyArray<{
    readonly id: string
    readonly attribution: string
  }>
}

export interface ReferenceLayerSpec {
  readonly id: string
  readonly type: 'fill' | 'line' | 'circle' | 'symbol'
  readonly source: string
  readonly 'source-layer': string
  readonly minzoom: number
  readonly maxzoom: number
  readonly filter: ReadonlyArray<unknown>
  readonly layout?: Record<string, unknown>
  readonly paint?: Record<string, unknown>
}

export interface ReferenceSourceSpec {
  readonly type: 'vector'
  readonly tiles: ReadonlyArray<string>
  readonly minzoom: number
  readonly maxzoom: number
  readonly attribution: string
}

export interface ReferenceDatasetLayers {
  readonly sourceId: string
  readonly source: ReferenceSourceSpec
  readonly layers: ReadonlyArray<ReferenceLayerSpec>
}

const sourceIdFor = (datasetId: string): string => `reference:${datasetId}`

const layerIdFor = (datasetId: string, category: string, kind: 'fill' | 'line' | 'point' | 'label'): string =>
  `reference:${datasetId}:${category}:${kind}`

const categoryFilter = (category: string): ReadonlyArray<unknown> =>
  ['==', ['get', 'category'], category] as const

const sourceTilesFor = (datasetId: string, manifestPmtilesPath: string): ReadonlyArray<string> => {
  // Manifest writes pmtilesPath relative to the build dir. Browser fetches via
  // the Leitbild API under /map/datasets/<id>/current/<file-base>. We construct
  // an ordinary HTTP MVT template so MapLibre does not depend on a browser-side
  // PMTiles custom protocol during startup.
  // pmtilesPath is the file name only ("grid-norway.pmtiles") per A.1.
  const pmtilesBaseName = manifestPmtilesPath.replace(/\.pmtiles$/, '')
  return [`/map/datasets/${datasetId}/current/${pmtilesBaseName}/{z}/{x}/{y}.mvt`]
}

const sourceZoomRangeFor = (
  categories: DatasetManifestForLayers['categories'],
): { readonly minzoom: number; readonly maxzoom: number } => {
  if (categories.length === 0) return { minzoom: 0, maxzoom: 14 }
  return {
    minzoom: Math.min(...categories.map(category => category.minZoom)),
    maxzoom: Math.max(...categories.map(category => category.maxZoom)),
  }
}

export const buildReferenceDatasetLayers = (
  manifest: DatasetManifestForLayers,
  style: DatasetStyleModule,
): ReferenceDatasetLayers => {
  const sourceId = sourceIdFor(manifest.datasetId)
  const sourceZoomRange = sourceZoomRangeFor(manifest.categories)
  const source: ReferenceSourceSpec = {
    type: 'vector',
    tiles: sourceTilesFor(manifest.datasetId, manifest.artifact.pmtilesPath),
    minzoom: sourceZoomRange.minzoom,
    maxzoom: sourceZoomRange.maxzoom,
    attribution: composeAttributionFromManifest(manifest),
  }

  const fillLayers: ReferenceLayerSpec[] = []
  const lineLayers: ReferenceLayerSpec[] = []
  const pointLayers: ReferenceLayerSpec[] = []
  const labelLayers: ReferenceLayerSpec[] = []

  for (const cat of manifest.categories) {
    const layout = { visibility: 'visible' as const }
    fillLayers.push({
      id: layerIdFor(manifest.datasetId, cat.category, 'fill'),
      type: 'fill',
      source: sourceId,
      'source-layer': manifest.artifact.outputLayer,
      minzoom: cat.minZoom,
      maxzoom: cat.maxZoom,
      filter: categoryFilter(cat.category),
      layout,
      paint: style.fillFor(cat.category),
    })
    lineLayers.push({
      id: layerIdFor(manifest.datasetId, cat.category, 'line'),
      type: 'line',
      source: sourceId,
      'source-layer': manifest.artifact.outputLayer,
      minzoom: cat.minZoom,
      maxzoom: cat.maxZoom,
      filter: categoryFilter(cat.category),
      layout: { ...layout, 'line-join': 'round', 'line-cap': 'round' },
      paint: style.lineFor(cat.category),
    })
    const pointSpec = style.pointFor?.(cat.category) ?? null
    if (pointSpec) {
      pointLayers.push({
        id: layerIdFor(manifest.datasetId, cat.category, 'point'),
        type: 'circle',
        source: sourceId,
        'source-layer': manifest.artifact.outputLayer,
        minzoom: cat.minZoom,
        maxzoom: cat.maxZoom,
        filter: categoryFilter(cat.category),
        layout,
        paint: pointSpec.paint,
      })
    }
    const labelSpec = style.labelFor?.(cat.category) ?? null
    if (labelSpec) {
      labelLayers.push({
        id: layerIdFor(manifest.datasetId, cat.category, 'label'),
        type: 'symbol',
        source: sourceId,
        'source-layer': manifest.artifact.outputLayer,
        minzoom: style.labelMinZoomFor?.(cat.category, cat.minZoom) ?? cat.minZoom,
        maxzoom: cat.maxZoom,
        filter: categoryFilter(cat.category),
        layout: { ...layout, ...labelSpec.layout },
        paint: labelSpec.paint,
      })
    }
  }

  return {
    sourceId,
    source,
    // Order: fills below lines below points below labels. Wiring in A.6 inserts
    // the whole block above the base map and below operational layers via
    // MapLibre's beforeId parameter.
    layers: [...fillLayers, ...lineLayers, ...pointLayers, ...labelLayers],
  }
}

export const __internals = { sourceIdFor, layerIdFor, sourceTilesFor, categoryFilter }
