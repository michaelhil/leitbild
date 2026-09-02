import type { ScenarioAuthoringCatalog } from '../core/scenarios/authoring.ts'
import type { ScenarioDefinition } from '../core/scenarios/definition.ts'

export type AuthoringPack = ScenarioAuthoringCatalog['packs'][number]
export type AuthoringItemType = AuthoringPack['itemTypes'][number]
export type AuthoringField = AuthoringItemType['fields'][number]
export type Path = ReadonlyArray<string | number>

export interface ScenarioPackSelectionRecord {
  id: string
  runtime?: string
  config: Record<string, unknown>
  recording?: { profileId: string; intervalMs?: number }
  items: Array<Record<string, unknown> & { type: string; id: string; label: string }>
}

export type ScenarioDraft = Omit<ScenarioDefinition, 'packs' | 'timeline'> & {
  packs: Array<ScenarioPackSelectionRecord>
  timeline: NonNullable<ScenarioDefinition['timeline']>
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

export const needsPlacement = (item: unknown, placement: AuthoringItemType['placement']): boolean =>
  !!placement && valueAtPath(item, placement.path) === undefined
  && !(placement.orReference && valueAtPath(item, placement.orReference))

export const setValueAtPath = (value: unknown, path: Path, next: unknown): void => {
  if (path.length === 0) throw new Error('authoring path cannot be empty')
  if (next === undefined) {
    // A tuple coordinate is one optional value, not a sparse JSON array.
    if (typeof path.at(-1) === 'number' && path.length > 1) { setValueAtPath(value, path.slice(0, -1), undefined); return }
    const remove = (node: unknown, depth: number): void => {
      if (!node || typeof node !== 'object') return
      const record = node as Record<string | number, unknown>
      const key = path[depth]!
      if (depth === path.length - 1) delete record[key]
      else {
        remove(record[key], depth + 1)
        if (record[key] && typeof record[key] === 'object' && Object.keys(record[key] as object).length === 0) delete record[key]
      }
    }
    remove(value, 0)
    return
  }
  let current = value
  path.forEach((segment, index) => {
    if (current === null || typeof current !== 'object') throw new Error(`invalid authoring path at ${String(segment)}`)
    if (index === path.length - 1) {
      if (next === undefined) delete (current as Record<string | number, unknown>)[segment]
      else (current as Record<string | number, unknown>)[segment] = next
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

export const newCollectionRow = (collection: AuthoringItemType['collections'][number], rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => {
  const row = deepCopy(collection.defaultItem)
  if (collection.keyframes) {
    const { timePath, increment } = collection.keyframes
    const latest = Math.max(0, ...rows.map(row => Number(valueAtPath(row, timePath)) || 0))
    setValueAtPath(row, timePath, latest + increment)
  }
  return row
}

export const createEmptyScenarioDefinition = (): ScenarioDraft => ({
  id: `scenario-${crypto.randomUUID()}`,
  title: 'Untitled scenario',
  objectives: [],
  connections: [],
  packs: [],
  world: { startsAt: new Date().toISOString(), environment: {} },
  view: {
    map: {
        center: [10.7522, 59.9139],
        zoom: 11,
        hiddenLayers: [],
    },
    rail: { sections: [] },
  },
  timeline: { cues: [] },
})

export const selectionFor = (
  source: ScenarioDraft,
  packId: string,
): ScenarioPackSelectionRecord | undefined => source.packs.find(selection => selection.id === packId)

export const itemTypeFor = (
  catalog: ScenarioAuthoringCatalog,
  packId: string,
  item: { readonly type: string },
): AuthoringItemType | undefined => catalog.packs
  .find(pack => pack.id === packId)?.itemTypes.find(type => type.id === item.type)
