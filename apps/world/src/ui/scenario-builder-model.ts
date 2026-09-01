import type { ScenarioAuthoringCatalog } from '../core/scenarios/authoring.ts'

export type AuthoringPack = ScenarioAuthoringCatalog['packs'][number]
export type AuthoringItemType = AuthoringPack['itemTypes'][number]
export type AuthoringField = AuthoringItemType['fields'][number]
export type Path = ReadonlyArray<string | number>

export interface ScenarioPackSelectionRecord {
  id: string
  runtime?: string
  config: Record<string, unknown>
  items: Array<Record<string, unknown> & { type: string; id: string; label: string }>
}

export interface ScenarioSourceRecord {
  id: string
  title: string
  description?: string
  objectives: Array<string>
  recording: Array<{ packId: string; profileId: string; intervalMs?: number }>
  connections: Array<{
    id: string
    type: 'electrical'
    system: { objectId: string; portId: string }
    network: { objectId: string; portId: string }
  }>
  packs: Array<ScenarioPackSelectionRecord>
  world: { startsAt: string; environment: Record<string, unknown> }
  view: {
    map: Record<string, unknown> & { center: [number, number]; zoom: number; layers: Array<string> }
    rail?: Record<string, unknown> & { width?: number; sections: Array<Record<string, unknown>> }
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

export const createEmptyScenarioSource = (): ScenarioSourceRecord => ({
  id: `scenario-${crypto.randomUUID()}`,
  title: 'Untitled scenario',
  objectives: [],
  recording: [],
  connections: [],
  packs: [],
  world: { startsAt: new Date().toISOString(), environment: {} },
  view: {
    map: {
        center: [10.7522, 59.9139],
        zoom: 11,
        layers: ['objects', 'routes', 'traffic', 'weather', 'grid', 'highlights'],
    },
    rail: { width: 340, sections: [] },
  },
  timeline: { cues: [] },
})

export const selectionFor = (
  source: ScenarioSourceRecord,
  packId: string,
): ScenarioPackSelectionRecord | undefined => source.packs.find(selection => selection.id === packId)

export const itemTypeFor = (
  catalog: ScenarioAuthoringCatalog,
  packId: string,
  item: { readonly type: string },
): AuthoringItemType | undefined => catalog.packs
  .find(pack => pack.id === packId)?.itemTypes.find(type => type.id === item.type)
