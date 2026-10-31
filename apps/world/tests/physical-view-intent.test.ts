import { expect, test } from 'bun:test'
import type { PhysicalScenePresentation } from '../src/ui/map/physical-scene/types.ts'
import { requestedPhysicalLayoutView, physicalOpacityPreparationText } from '../src/ui/physical-layout/view-intent.ts'
import { physicalCollectionFloorChanges, physicalCollectionFloorGroups, physicalCollectionMixedSettings } from '../src/ui/physical-layout/collection-floors.ts'
import { physicalCollectionLayerChanges, physicalCollectionLayerChoices } from '../src/ui/physical-layout/collection-layers.ts'
import { retryablePhysicalLayouts } from '../src/ui/physical-layout/retry.ts'

const scene = (id: string): PhysicalScenePresentation => ({
  descriptor: { id, revision: 'r', targetObjectId: id, anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [10, 10, 8] }, locationValid: true, modelDigest: 'digest', subjectIds: [], geometryKey: 'shared', levels: [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: 2 }, { id: 'upper', label: 'Upper', elevation: 4, cutHeight: 6 }], layers: [{ id: 'routes', label: 'Utility routes', defaultVisible: true }] },
  view: { mode: '3d', levelId: 'lower', separation: 0, live: true, detail: 'auto', cutaway: true }, status: 'ready', occurrenceCount: 10,
})

test('a second slider edit composes with the first pending intent while actual geometry remains unchanged', () => {
  const source = scene('a'), first: PhysicalScenePresentation = { ...source, opacityPreparation: { status: 'loading', requested: { wallOpacity: 1, floorOpacity: .5 } } }
  const secondIntent = { ...requestedPhysicalLayoutView(first), wallOpacity: .4 }
  expect(secondIntent.floorOpacity).toBe(.5)
  expect(first.view.floorOpacity).toBeUndefined()
  const pending: PhysicalScenePresentation = { ...first, opacityPreparation: { status: 'loading', requested: { wallOpacity: secondIntent.wallOpacity, floorOpacity: secondIntent.floorOpacity! } } }
  const group = physicalCollectionFloorGroups([pending], value => value.descriptor.id)[0]!
  expect(physicalCollectionFloorChanges(group, 'upper')[0]!.view).toEqual({ ...source.view, levelId: 'upper', wallOpacity: .4, floorOpacity: .5 })
  const layer = physicalCollectionLayerChoices([pending], value => value.descriptor.id)[0]!
  expect(physicalCollectionLayerChanges(layer, false)[0]!.view).toEqual({ ...source.view, hiddenLayerIds: ['routes'], wallOpacity: .4, floorOpacity: .5 })
  expect(source.view).toEqual(first.view)
})

test('collection Mixed reflects pending editing intent rather than its common opaque placeholder', () => {
  const a = scene('a'), b = scene('b'), pending: PhysicalScenePresentation = { ...a, opacityPreparation: { status: 'loading', requested: { wallOpacity: .4, floorOpacity: .5 } } }
  expect(physicalCollectionMixedSettings([pending, b])).toEqual(['wallOpacity', 'floorOpacity'])
  expect(physicalCollectionMixedSettings([pending, { ...b, view: { ...b.view, wallOpacity: .4, floorOpacity: .5 } }])).toEqual([])
})

test('pending status distinguishes requested/applied styles, groups equal placements and exposes scoped Retry', () => {
  const a: PhysicalScenePresentation = { ...scene('a'), opacityPreparation: { status: 'loading', requested: { wallOpacity: .4, floorOpacity: .5 } } }, b = { ...a, descriptor: { ...a.descriptor, id: 'b' } }
  const text = physicalOpacityPreparationText([a, b])
  expect(text).toContain('2 layouts'); expect(text).toContain('requested wall 40%, floor 50%'); expect(text).toContain('showing wall 100%, floor 100%')
  expect(text.match(/Preparing architecture transparency/g)).toHaveLength(1)
  const failed: PhysicalScenePresentation = { ...a, opacityPreparation: { ...a.opacityPreparation!, status: 'unavailable', reason: 'Worker failed' } }
  expect(physicalOpacityPreparationText([failed])).toContain('Worker failed')
  expect(retryablePhysicalLayouts([failed, b], null, null)).toEqual(['a'])
  expect(retryablePhysicalLayouts([failed, b], 'b', null)).toEqual([])
})
