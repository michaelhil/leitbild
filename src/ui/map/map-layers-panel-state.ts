// Pure state module for the reference-data layer toggle panel.
// Owns: per-category visibility, defaults, persistence shape.
// Does not: touch the DOM, MapLibre, or storage directly. The Svelte component
// wires this state to UI events; the imperative MapSurface wiring (A.6) wires
// state changes to map.setLayoutProperty.

export interface MapLayersStorage {
  readonly get: (key: string) => string | null
  readonly set: (key: string, value: string) => void
}

export interface MapLayersPanelInit {
  readonly datasetId: string
  readonly categories: ReadonlyArray<string>
  readonly defaultsOn: ReadonlyArray<string>
  readonly controlInstanceId: string | null
  readonly storage?: MapLayersStorage
}

export interface MapLayersPanelState {
  readonly datasetId: string
  readonly visibility: Readonly<Record<string, boolean>>
}

const STORAGE_PREFIX = 'leitbild:layers'

const storageKey = (datasetId: string, controlInstanceId: string): string =>
  `${STORAGE_PREFIX}:${datasetId}:${controlInstanceId}`

const inMemoryStorage = (): MapLayersStorage => {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v) },
  }
}

const readPersisted = (
  storage: MapLayersStorage | undefined,
  controlInstanceId: string | null,
  datasetId: string,
): Record<string, boolean> | null => {
  if (!storage || !controlInstanceId) return null
  const raw = storage.get(storageKey(datasetId, controlInstanceId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

const writePersisted = (
  storage: MapLayersStorage | undefined,
  controlInstanceId: string | null,
  datasetId: string,
  visibility: Record<string, boolean>,
): void => {
  if (!storage || !controlInstanceId) return
  try {
    storage.set(storageKey(datasetId, controlInstanceId), JSON.stringify(visibility))
  } catch {
    // Storage failure is non-fatal; toggles still apply in-memory.
  }
}

export const defaultVisibility = (
  categories: ReadonlyArray<string>,
  defaultsOn: ReadonlyArray<string>,
): Record<string, boolean> => {
  const onSet = new Set(defaultsOn)
  const out: Record<string, boolean> = {}
  for (const c of categories) out[c] = onSet.has(c)
  return out
}

export interface MapLayersPanelController {
  readonly state: MapLayersPanelState
  readonly isVisible: (category: string) => boolean
  readonly toggle: (category: string) => MapLayersPanelController
  readonly setVisible: (category: string, visible: boolean) => MapLayersPanelController
  readonly setAll: (visible: boolean) => MapLayersPanelController
}

const buildController = (
  state: MapLayersPanelState,
  init: { readonly controlInstanceId: string | null; readonly storage: MapLayersStorage | undefined },
): MapLayersPanelController => ({
  state,
  isVisible: (category) => state.visibility[category] ?? false,
  toggle: (category) => {
    const next = { ...state.visibility, [category]: !state.visibility[category] }
    writePersisted(init.storage, init.controlInstanceId, state.datasetId, next)
    return buildController({ ...state, visibility: next }, init)
  },
  setVisible: (category, visible) => {
    const next = { ...state.visibility, [category]: visible }
    writePersisted(init.storage, init.controlInstanceId, state.datasetId, next)
    return buildController({ ...state, visibility: next }, init)
  },
  setAll: (visible) => {
    const next: Record<string, boolean> = {}
    for (const k of Object.keys(state.visibility)) next[k] = visible
    writePersisted(init.storage, init.controlInstanceId, state.datasetId, next)
    return buildController({ ...state, visibility: next }, init)
  },
})

export const createMapLayersPanel = (init: MapLayersPanelInit): MapLayersPanelController => {
  const storage = init.storage ?? inMemoryStorage()
  const defaults = defaultVisibility(init.categories, init.defaultsOn)
  const persisted = readPersisted(storage, init.controlInstanceId, init.datasetId)
  const visibility: Record<string, boolean> = { ...defaults }
  if (persisted) {
    for (const c of init.categories) {
      if (typeof persisted[c] === 'boolean') visibility[c] = persisted[c]
    }
  }
  const state: MapLayersPanelState = { datasetId: init.datasetId, visibility }
  return buildController(state, { controlInstanceId: init.controlInstanceId, storage })
}

export const aeroNorwayDefaultsOn: ReadonlyArray<string> = [
  'cta',
  'tma',
  'ctr',
  'restricted',
  'prohibited',
  'danger',
  'airport',
  'exclusion',
]
