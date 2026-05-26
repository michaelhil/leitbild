import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  buildReferenceDatasetLayers,
  type DatasetManifestForLayers,
  type DatasetStyleModule,
  type ReferenceLayerSpec,
} from './reference-layer-factory.ts'
import { aeroNorwayStyleModule } from '../../packs/aviation/ui/aero-norway-style.ts'

// Imperative controller that fetches /map/capabilities.json, registers
// reference-data vector sources + layers against an active MapLibre map, and
// applies per-category visibility from the layers panel.
//
// Pure logic only; no DOM, no Svelte. The Svelte component (MapSurface)
// instantiates the controller and forwards toggle events. The controller
// buffers visibility state so toggles arriving before the map finishes
// registering layers are applied as soon as the layers exist.

const CAPABILITIES_URL = '/map/capabilities.json'

interface ReferenceTilesetForController {
  readonly kind: 'reference'
  readonly datasetId: string
  readonly schemaVersion: number
  readonly builtAt: string
  readonly buildId: string
  readonly airac?: string
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
  readonly sources: ReadonlyArray<{ readonly id: string; readonly kind: string }>
  readonly licences: ReadonlyArray<{ readonly id: string; readonly attribution: string }>
}

interface ManifestForController {
  readonly schemaVersion: number
  readonly tilesets: ReadonlyArray<{ readonly kind: string } & Record<string, unknown>>
}

const isReference = (entry: { readonly kind: string }): entry is ReferenceTilesetForController =>
  entry.kind === 'reference'

const styleModuleFor = (datasetId: string): DatasetStyleModule | null => {
  if (datasetId === 'aero-norway') return aeroNorwayStyleModule
  return null
}

const manifestEntryForLayers = (tileset: ReferenceTilesetForController): DatasetManifestForLayers => ({
  datasetId: tileset.datasetId,
  artifact: tileset.artifact,
  categories: tileset.categories,
  licences: tileset.licences.map(l => ({ id: l.id, attribution: l.attribution })),
})

export interface ReferenceDatasetControllerConfig {
  readonly map: MapLibreMap
  readonly beforeLayerId?: string | null
  readonly fetchFn?: (input: string) => Promise<Response>
  readonly capabilitiesUrl?: string
  readonly logger?: (message: string) => void
}

export interface RegisteredReferenceDataset {
  readonly datasetId: string
  readonly categories: ReadonlyArray<string>
  readonly layerIdsByCategory: Readonly<Record<string, ReadonlyArray<string>>>
}

export interface ReferenceDatasetController {
  readonly registered: ReadonlyArray<RegisteredReferenceDataset>
  readonly setCategoryVisibility: (datasetId: string, category: string, visible: boolean) => void
  readonly setBulkVisibility: (datasetId: string, visibility: Readonly<Record<string, boolean>>) => void
}

const collectLayerIdsByCategory = (layers: ReadonlyArray<ReferenceLayerSpec>): Record<string, string[]> => {
  const byCategory: Record<string, string[]> = {}
  for (const layer of layers) {
    // Layer id encoded as `reference:<dataset>:<category>:<kind>`; pull category.
    const parts = layer.id.split(':')
    const category = parts[2]
    if (!category) continue
    const list = byCategory[category] ?? []
    list.push(layer.id)
    byCategory[category] = list
  }
  return byCategory
}

const safeSetVisibility = (
  map: MapLibreMap,
  layerId: string,
  visible: boolean,
  log: (m: string) => void,
): void => {
  try {
    if (!map.getLayer(layerId)) return
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  } catch (err) {
    log(`reference-data: setLayoutProperty failed for ${layerId} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

const fetchManifest = async (
  url: string,
  fetchFn: (input: string) => Promise<Response>,
  log: (m: string) => void,
): Promise<ManifestForController | null> => {
  try {
    const response = await fetchFn(url)
    if (!response.ok) {
      log(`reference-data: ${url} returned HTTP ${response.status}; no reference layers will be registered`)
      return null
    }
    const parsed = await response.json() as ManifestForController
    if (!Array.isArray(parsed.tilesets)) {
      log('reference-data: manifest is missing tilesets[]; no reference layers will be registered')
      return null
    }
    return parsed
  } catch (err) {
    log(`reference-data: manifest fetch failed — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

const registerOne = (
  map: MapLibreMap,
  tileset: ReferenceTilesetForController,
  style: DatasetStyleModule,
  beforeLayerId: string | null,
  log: (m: string) => void,
): RegisteredReferenceDataset | null => {
  try {
    const built = buildReferenceDatasetLayers(manifestEntryForLayers(tileset), style)
    if (!map.getSource(built.sourceId)) {
      map.addSource(built.sourceId, {
        type: built.source.type,
        url: built.source.url,
        attribution: built.source.attribution,
      })
    }
    for (const layer of built.layers) {
      if (map.getLayer(layer.id)) continue
      const before = beforeLayerId && map.getLayer(beforeLayerId) ? beforeLayerId : undefined
      // Cast to unknown then to maplibre's expected layer spec shape; our specs
      // are structurally compatible but the loose `Record<string, unknown>` paint
      // doesn't satisfy maplibre's strict types here.
      map.addLayer(layer as unknown as Parameters<MapLibreMap['addLayer']>[0], before)
    }
    return {
      datasetId: tileset.datasetId,
      categories: tileset.categories.map(c => c.category),
      layerIdsByCategory: collectLayerIdsByCategory(built.layers),
    }
  } catch (err) {
    log(`reference-data: failed to register ${tileset.datasetId} — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export const createReferenceDataController = async (
  config: ReferenceDatasetControllerConfig,
): Promise<ReferenceDatasetController> => {
  const log = config.logger ?? ((msg: string) => console.warn(msg))
  const fetchFn = config.fetchFn ?? ((input: string) => globalThis.fetch(input))
  const url = config.capabilitiesUrl ?? CAPABILITIES_URL
  const beforeLayerId = config.beforeLayerId ?? null

  const manifest = await fetchManifest(url, fetchFn, log)
  const registered: RegisteredReferenceDataset[] = []
  if (manifest) {
    for (const entry of manifest.tilesets) {
      if (!isReference(entry)) continue
      const style = styleModuleFor(entry.datasetId)
      if (!style) {
        log(`reference-data: no style module registered for dataset "${entry.datasetId}" — skipping`)
        continue
      }
      const result = registerOne(config.map, entry, style, beforeLayerId, log)
      if (result) registered.push(result)
    }
  }

  return {
    registered,
    setCategoryVisibility: (datasetId, category, visible) => {
      const dataset = registered.find(d => d.datasetId === datasetId)
      if (!dataset) return
      const layerIds = dataset.layerIdsByCategory[category] ?? []
      for (const id of layerIds) safeSetVisibility(config.map, id, visible, log)
    },
    setBulkVisibility: (datasetId, visibility) => {
      const dataset = registered.find(d => d.datasetId === datasetId)
      if (!dataset) return
      for (const [category, visible] of Object.entries(visibility)) {
        const layerIds = dataset.layerIdsByCategory[category] ?? []
        for (const id of layerIds) safeSetVisibility(config.map, id, visible, log)
      }
    },
  }
}

export const __internals = { collectLayerIdsByCategory, isReference, styleModuleFor }
