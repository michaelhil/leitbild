import { expect, test } from 'bun:test'
import { createPhysicalAnnotationSceneKey } from '../src/ui/physical-layout/annotation-scene.ts'
import type { PhysicalScenePresentation } from '../src/ui/map/physical-scene/types.ts'

const scene = (): PhysicalScenePresentation => ({
  descriptor: { id: 'unit', revision: 'r5', targetObjectId: 'plant', anchor: [11, 59], bearing: 0, bounds: { min: [0, 0, 0], max: [88, 36, 30] }, levels: [{ id: 'deck', label: 'Deck', elevation: 15, cutHeight: 2 }], locationValid: true, subjectIds: [], modelDigest: 'model' },
  status: 'ready', renderRevision: 7, occurrenceCount: 719,
  view: { mode: '3d', levelId: 'all', cutaway: true, separation: 0, detail: 'auto', live: true },
})

test('pending layers and failure wording retain completed annotation visibility', () => {
  const key = createPhysicalAnnotationSceneKey(), initial = scene(), expected = key([initial])
  expect(key([{ ...initial, layerPreparation: { status: 'loading', layerIds: ['electrical'] } }])).toBe(expected)
  expect(key([{ ...initial, reason: 'Retry available' }])).toBe(expected)
})

test('actual source, draw geometry, floor and visibility changes invalidate completed tests', () => {
  const key = createPhysicalAnnotationSceneKey(), initial = scene(), expected = key([initial])
  const changes: ReadonlyArray<PhysicalScenePresentation> = [
    { ...initial, descriptor: { ...initial.descriptor } },
    { ...initial, status: 'loading' }, { ...initial, renderRevision: 8 },
    ...([{ mode: '2d' }, { levelId: 'deck' }, { cutaway: false }, { separation: 20 }, { detail: 'hidden' }, { live: false }, { surroundings: true }, { hiddenLayerIds: ['electrical'] }] as const).map(view => ({ ...initial, view: { ...initial.view, ...view } })),
  ]
  for (const next of changes) expect(key([next])).not.toBe(expected)
  expect(key([])).not.toBe(expected)
  expect(key([initial, scene()])).not.toBe(expected)
})
