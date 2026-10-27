import { expect, test } from 'bun:test'
import { createPhysicalInspectionWorkingSet } from '../src/ui/map/physical-scene/inspection-working-set.ts'
import { preparePhysicalGeometry, physicalPreparedGeometryBytes } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
const source: PackPhysicalScene = { id: 'scene', revision: 'source', targetObjectId: 'owner', anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [4, 4, 8] }, levels: [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: 2 }, { id: 'upper', label: 'Upper', elevation: 4, cutHeight: 6 }], objects: [{ id: 'equipment', label: 'Equipment', kind: 'equipment', levelId: 'lower', subjectIds: ['equipment'], positions: [0, 0, 0, 3, 0, 7, 0, 3, 7] }] }
const lower = { ...defaultPhysicalSceneView(source.levels), mode: '3d' as const }, plan = { ...lower, mode: '2d' as const }
test('semantic Plan and spatial working sets share placement assets and count owned storage once', () => {
  const retained = createPhysicalInspectionWorkingSet(), spatial = preparePhysicalGeometry(source, lower, 'spatial'), drawing = preparePhysicalGeometry(source, plan, 'plan')
  for (const id of ['placement-a', 'placement-b']) { retained.remember(id, lower, undefined, ['routes'], spatial); retained.remember(id, plan, undefined, ['routes'], drawing) }
  expect(retained.select('placement-a', lower)?.asset).toBe(spatial); expect(retained.select('placement-b', plan)?.coverage).toEqual(['routes'])
  expect(retained.metrics()).toEqual({ scenes: 2, representations: 4, uniqueViews: 2, bytes: physicalPreparedGeometryBytes(spatial) + physicalPreparedGeometryBytes(drawing) })
  expect(retained.select('placement-a', { ...lower, wallOpacity: .2, floorOpacity: .1, live: false, hiddenLayerIds: ['routes'] })?.asset).toBe(spatial)
  retained.retainScenes(new Set(['placement-b'])); expect(retained.metrics().representations).toBe(2)
  retained.forget('placement-b'); expect(retained.metrics()).toEqual({ scenes: 0, representations: 0, uniqueViews: 0, bytes: 0 })
})
test('new floor/scope/separation geometry replaces its mode and never accumulates visited variants', () => {
  const retained = createPhysicalInspectionWorkingSet(), asset = preparePhysicalGeometry(source, lower, 'spatial'), drawing = preparePhysicalGeometry(source, plan, 'plan')
  retained.remember('placement', lower, 'scope', [], asset); retained.remember('placement', plan, 'scope', [], drawing)
  expect(retained.select('placement', { ...lower, levelId: 'upper' }, 'scope')).toBeUndefined(); expect(retained.metrics().uniqueViews).toBe(1)
  expect(retained.select('placement', plan, 'other-scope')).toBeUndefined(); expect(retained.metrics().bytes).toBe(0)
  const separated = { ...lower, levelId: 'all', separation: 1 }; retained.remember('placement', separated, undefined, [], asset)
  expect(retained.select('placement', { ...separated, separation: 12 })?.asset).toBe(asset)
  expect(retained.select('placement', { ...separated, separation: 0 })).toBeUndefined()
  retained.clear(); expect(retained.metrics().scenes).toBe(0)
})
