import { expect, test } from 'bun:test'
import { physicalCollectionLayerChoices, physicalCollectionLayerChanges } from '../src/ui/physical-layout/collection-layers.ts'
import type { PhysicalScenePresentation } from '../src/ui/map/physical-scene/types.ts'

const scene = (id: string, layers = [{ id: 'utility-routes', label: 'Utility routes', defaultVisible: false }], hiddenLayerIds?: ReadonlyArray<string>): PhysicalScenePresentation => ({
  descriptor: { id, revision: 'r', targetObjectId: id, anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [10, 10, 8] }, locationValid: true, modelDigest: 'digest', subjectIds: [], geometryKey: id, levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 2 }], layers },
  view: { mode: '2d', levelId: 'ground', separation: 9, live: false, detail: 'auto', cutaway: false, ...(hiddenLayerIds === undefined ? {} : { hiddenLayerIds }) }, status: 'ready', occurrenceCount: 10, renderRevision: 0,
})
const label = (value: PhysicalScenePresentation) => `Layout ${value.descriptor.id}`

test('one collection control reaches every declaring unit and campus without depending on the first model', () => {
  const unrelated = scene('no-layers', []), units = Array.from({length: 4}, (_, i) => scene(`unit-${i}`)), campus = scene('campus')
  const choices = physicalCollectionLayerChoices([unrelated, ...units, campus], label)
  expect(choices).toHaveLength(1)
  const choice = choices[0]!
  expect(choice.visible).toBe(false)
  expect(choice.memberLabels).toEqual([...units, campus].map(label))
  expect(physicalCollectionLayerChanges(choice, true).map(change => change.sceneId)).toEqual([...units, campus].map(value => value.descriptor.id))
  expect(physicalCollectionLayerChanges(choice, true).every(change => change.view.hiddenLayerIds?.length === 0)).toBe(true)
})

test('defaults and explicit visibility remain local, and both toggle directions resolve a Mixed selection', () => {
  const a = scene('a'), b = scene('b', [{ id: 'utility-routes', label: 'Utility routes', defaultVisible: true }]), c = scene('c', undefined, [])
  const choice = physicalCollectionLayerChoices([a, b, c], label)[0]!
  expect(choice.visible).toBeNull()
  for (const visible of [true, false]) {
    const changes = physicalCollectionLayerChanges(choice, visible)
    expect(changes.every(change => change.view.hiddenLayerIds?.includes('utility-routes') === !visible)).toBe(true)
    const next = choice.scenes.map((member, index) => ({ ...member, view: changes[index]!.view }))
    expect(physicalCollectionLayerChoices(next, label)[0]!.visible).toBe(visible)
  }
  expect(a.view.hiddenLayerIds).toBeUndefined()
  expect(c.view.hiddenLayerIds).toEqual([])
})

test('same local id with different labels and same label with different ids remain separately addressed', () => {
  const a = scene('a'), b = scene('b', [{ id: 'utility-routes', label: 'Drainage', defaultVisible: false }]), c = scene('c', [{ id: 'cables', label: 'Utility routes', defaultVisible: false }])
  const choices = physicalCollectionLayerChoices([a, b, c], label)
  expect(new Set(choices.map(choice => choice.key)).size).toBe(3)
  expect(choices.map(choice => physicalCollectionLayerChanges(choice, true).map(change => change.sceneId))).toEqual([['a'], ['b'], ['c']])
})

test('a layer action preserves each view, unrelated layer states and unknown retained hidden ids without mutating inputs', () => {
  const a = scene('a', [{ id: 'utility-routes', label: 'Utility routes', defaultVisible: false }, { id: 'roof', label: 'Roof', defaultVisible: false }]), b = scene('b', undefined, Object.freeze(['utility-routes', 'retained-hidden-id']))
  const choice = physicalCollectionLayerChoices([a, b], label).find(choice => choice.id === 'utility-routes')!
  const changes = physicalCollectionLayerChanges(choice, true)
  expect(changes[0]!.view).toEqual({ ...a.view, hiddenLayerIds: ['roof'] })
  expect(changes[1]!.view).toEqual({ ...b.view, hiddenLayerIds: ['retained-hidden-id'] })
  expect(b.view.hiddenLayerIds).toEqual(['utility-routes', 'retained-hidden-id'])
})

test('selection, replacement and annotation-only declarations are derived from the current population', () => {
  const a = scene('a'), b = scene('b'), c = scene('c', [{ id: 'dimensions', label: 'Dimensions', defaultVisible: true }])
  expect(physicalCollectionLayerChoices([], label)).toEqual([])
  expect(physicalCollectionLayerChoices([b, c], label).map(choice => choice.scenes.map(member => member.descriptor.id))).toEqual([['b'], ['c']])
  const replacement = { ...a, descriptor: { ...a.descriptor, layers: [{ id: 'cables', label: 'Cables', defaultVisible: false }] } }
  expect(physicalCollectionLayerChoices([replacement], label).map(choice => choice.id)).toEqual(['cables'])
  const stale = { ...physicalCollectionLayerChoices([a], label)[0]!, scenes: [replacement] }
  expect(() => physicalCollectionLayerChanges(stale, true)).toThrow('no longer declared')
})
