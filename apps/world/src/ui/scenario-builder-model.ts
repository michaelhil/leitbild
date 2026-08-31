import type { ScenarioAuthoringCatalog } from '../core/scenarios/authoring.ts'

export type AuthoringFeature = ScenarioAuthoringCatalog['features'][number]
export type AuthoringItemType = AuthoringFeature['itemTypes'][number]
export type AuthoringField = AuthoringItemType['fields'][number]
export type Path = ReadonlyArray<string | number>

export interface ScenarioDraftRecord {
  id: string
  schemaVersion: 1
  title: string
  description?: string
  objectives: Array<string>
  packs: Array<string>
  runtimeOverrides: Record<string, string>
  world: { startsAt: string; environment: Record<string, unknown> }
  items: Array<Record<string, unknown> & { pack: string; type: string; id: string; label: string }>
  initialContexts: Array<{ objectId: string; context: unknown }>
  processSystems: Array<Record<string, unknown> & { id: string }>
  runtimeConfigs: Record<string, unknown>
  surface: {
    schemaVersion: 1
    regions: Array<Record<string, unknown> & { id: string; primitive: string; visible: boolean; config: Record<string, unknown> }>
  }
  timeline: { cues: Array<unknown> }
}

// Authoring metadata is JSON data. JSON cloning also strips Svelte's reactive
// proxies when catalog values cross into the editable draft.
export const deepCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const valueAtPath = (value: unknown, path: Path): unknown => {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[segment]
  }
  return current
}

export const setValueAtPath = (value: unknown, path: Path, next: unknown): void => {
  if (path.length === 0) throw new Error('authoring path cannot be empty')
  let current = value
  path.forEach((segment, index) => {
    if (current === null || typeof current !== 'object') throw new Error(`invalid authoring path at ${String(segment)}`)
    if (index === path.length - 1) {
      ;(current as Record<string | number, unknown>)[segment] = next
      return
    }
    const candidate = (current as Record<string | number, unknown>)[segment]
    if (candidate === null || typeof candidate !== 'object') {
      const following = path[index + 1]
      ;(current as Record<string | number, unknown>)[segment] = typeof following === 'number' ? [] : {}
    }
    current = (current as Record<string | number, unknown>)[segment]
  })
}

export const createEmptyScenarioDraft = (): ScenarioDraftRecord => ({
  id: `scenario-${crypto.randomUUID()}`,
  schemaVersion: 1,
  title: 'Untitled scenario',
  objectives: [],
  packs: [],
  runtimeOverrides: {},
  world: { startsAt: new Date().toISOString(), environment: {} },
  items: [],
  initialContexts: [],
  processSystems: [],
  runtimeConfigs: {},
  surface: {
    schemaVersion: 1,
    regions: [{
      id: 'main-map',
      primitive: 'map',
      visible: true,
      config: {
        center: [10.7522, 59.9139],
        zoom: 11,
        layers: ['objects', 'routes', 'traffic', 'weather', 'grid', 'highlights'],
      },
    }, {
      id: 'left-rail',
      primitive: 'objectRail',
      visible: true,
      config: { width: 340, sections: [] },
    }, {
      id: 'system-footer', primitive: 'systemFooter', visible: true, config: {},
    }, {
      id: 'guidance-overlay', primitive: 'guidanceOverlay', visible: true, config: {},
    }],
  },
  timeline: { cues: [] },
})

export const itemTypeFor = (
  catalog: ScenarioAuthoringCatalog,
  item: { readonly pack: string; readonly type: string },
): AuthoringItemType | undefined => catalog.features
  .find(feature => feature.id === item.pack)?.itemTypes.find(type => type.id === item.type)
