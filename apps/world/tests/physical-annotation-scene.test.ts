import { expect, test } from 'bun:test'
import { createPhysicalAnnotationSceneKey } from '../src/ui/physical-layout/annotation-scene.ts'
import type { PhysicalScenePresentation } from '../src/ui/map/physical-scene/types.ts'

const scene = (): PhysicalScenePresentation => ({
  descriptor: { id: 'unit', revision: 'r5', targetObjectId: 'plant', anchor: [11, 59], bearing: 0, bounds: { min: [0, 0, 0], max: [88, 36, 30] }, levels: [{ id: 'deck', label: 'Deck', elevation: 15, cutHeight: 2 }], locationValid: true, subjectIds: [], modelDigest: 'model' },
  status: 'ready', renderRevision: 7, occurrenceCount: 719,
  view: { mode: '3d', levelId: 'all', cutaway: true, separation: 0, detail: 'auto', live: true, wallOpacity: 0.4, floorOpacity: 1 },
})

test('pending requests and fractional magnitude retain completed annotation visibility', () => {
  const key = createPhysicalAnnotationSceneKey(), initial = scene(), expected = key([initial])
  expect(key([{ ...initial, opacityPreparation: { status: 'loading', requested: { wallOpacity: 0.8, floorOpacity: 0.2 } } }])).toBe(expected)
  expect(key([{ ...initial, opacityPreparation: { status: 'unavailable', reason: 'worker rejected request', requested: { wallOpacity: 0.8, floorOpacity: 0.2 } }, reason: 'Retry available' }])).toBe(expected)
  expect(key([{ ...initial, layerPreparation: { status: 'loading', layerIds: ['electrical'] } }])).toBe(expected)
  expect(key([{ ...initial, view: { ...initial.view, wallOpacity: 0.9 } }])).toBe(expected)
  const { floorOpacity: _opacity, ...implicitView } = initial.view
  const implicitOpaque = { ...initial, view: implicitView }
  expect(key([implicitOpaque])).toBe(expected)
})

test('actual source, draw geometry, floor and visibility changes invalidate completed tests', () => {
  const key = createPhysicalAnnotationSceneKey(), initial = scene(), expected = key([initial])
  const changes: ReadonlyArray<PhysicalScenePresentation> = [
    { ...initial, descriptor: { ...initial.descriptor } },
    { ...initial, status: 'loading' }, { ...initial, renderRevision: 8 },
    ...([{ mode: '2d' }, { levelId: 'deck' }, { cutaway: false }, { separation: 20 }, { detail: 'hidden' }, { live: false }, { surroundings: true }, { hiddenLayerIds: ['electrical'] }, { wallOpacity: 0 }, { wallOpacity: 1 }, { floorOpacity: 0.5 }, { floorOpacity: 0 }] as const).map(view => ({ ...initial, view: { ...initial.view, ...view } })),
  ]
  for (const next of changes) expect(key([next])).not.toBe(expected)
  expect(key([])).not.toBe(expected)
  expect(key([initial, scene()])).not.toBe(expected)
})
