import { expect, test } from 'bun:test'
import { retryablePhysicalLayouts } from '../src/ui/physical-layout/retry.ts'
import { defaultPhysicalSceneView, type PhysicalScenePresentation } from '../src/ui/map/physical-scene/types.ts'
const scene = (id: string, group: string, status: PhysicalScenePresentation['status'], failedLayer = false): PhysicalScenePresentation => ({
  descriptor: { id, label: id, targetObjectId: `owner:${id}`, revision: 'retained', modelDigest: 'exact', anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 1 }], locationValid: true, subjectIds: [], group: { id: group, label: group } },
  view: defaultPhysicalSceneView([]), status, occurrenceCount: 1,
  ...(failedLayer ? { layerPreparation: { status: 'unavailable', layerIds: ['utilities'], reason: 'Worker refused the layer' } } : {}),
})
test('Retry includes failed layers on valid geometry and complete failures, restricted to the selected source/group', () => {
  const values = [scene('a', 'site-one', 'ready', true), scene('b', 'site-one', 'unavailable'), scene('c', 'site-two', 'unavailable'), scene('d', 'site-one', 'loading'), scene('e', 'site-one', 'ready')]
  expect(retryablePhysicalLayouts(values, 'a', null)).toEqual(['a'])
  expect(retryablePhysicalLayouts(values, 'e', null)).toEqual([])
  expect(retryablePhysicalLayouts(values, null, 'site-one')).toEqual(['a', 'b'])
  expect(retryablePhysicalLayouts(values, null, null)).toEqual(['a', 'b', 'c'])
  expect(values[0]!.status).toBe('ready')
  expect(values[0]!.layerPreparation!.status).toBe('unavailable')
})
