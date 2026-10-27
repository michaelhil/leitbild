import { expect, test } from 'bun:test'
import { packPhysicalSceneSchema, type PackPhysicalScene } from '../src/core/packs/scene.ts'
import { normalizePhysicalDraftingScene, physicalDraftingAuthoringBounds } from '../src/packs/physical-layout/native/drafting/frame.ts'
import { physicalPlanFrame, physicalPlanDrawingBounds, visiblePhysicalPlanDrawing } from '../src/ui/physical-layout/plan-drawing.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const scene: PackPhysicalScene = {
  id: 'model', revision: 'exact', targetObjectId: 'plant', anchor: [11, 59], bearing: 23,
  bounds: { min: [0, 0, 0], max: [4, 6, 3] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 1.2 }],
  scopes: [{ id: 'room', label: 'Room', kind: 'space', bounds: { min: [0, 0, 0], max: [4, 6, 3] }, levelIds: ['floor'], inspectionView: { bearing: 140, pitch: 58, target: [2, 3, 1] } }],
  layers: [{ id: 'notes', label: 'Notes', defaultVisible: true }],
  objects: [{ id: 'machine', label: 'Machine', kind: 'equipment', levelId: 'floor', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], materials: ['machine', 'light'], materialIndices: [0, 1, 0], subjectIds: ['pump'], scopeIds: ['room'], bounds: { min: [0, 0, 0], max: [1, 1, 0] }, featureLines: [{ positions: [0, 0, 0, 0, 1, 0] }] }],
  planDrawing: { views: [{ levelId: 'floor', bounds: { min: [-2, -2], max: [6, 8] }, primitives: [{ id: 'note', kind: 'text', depiction: 'annotation', scopeIds: ['room'], layerId: 'notes', anchor: [2, -1], bounds: { min: [-2, -2], max: [6, 0] }, text: 'Architectural note', height: .6, rotation: 25, align: 'middle', material: 'line' }] }] },
}
test('north-down source normalizes real geometry, winding, view, vectors and extents once while geographic placement stays canonical', () => {
  const before = JSON.stringify(scene), normalized = normalizePhysicalDraftingScene(scene, 'negative-y')
  expect(packPhysicalSceneSchema.safeParse(normalized).success).toBe(true)
  expect(normalized.anchor).toEqual(scene.anchor); expect(normalized.bearing).toBe(scene.bearing)
  expect(normalized.bounds).toEqual({ min: [0, -6, 0], max: [4, -0, 3] })
  expect(normalized.objects[0]!.positions).toEqual([0, -0, 0, 0, -1, 0, 1, -0, 0])
  expect(normalized.objects[0]!.materialIndices).toEqual([0, 0, 1])
  expect(normalized.objects[0]!.featureLines![0]!.positions).toEqual([0, -0, 0, 0, -1, 0])
  expect(normalized.scopes![0]!.inspectionView).toEqual({ bearing: 40, pitch: 58, target: [2, -3, 1] })
  expect(normalized.planDrawing!.views[0]!.primitives[0]).toMatchObject({ anchor: [2, 1], rotation: -25, bounds: { min: [-2, -0], max: [6, 2] } })
  expect(physicalDraftingAuthoringBounds(normalized.bounds, 'negative-y')).toEqual(scene.bounds)
  expect(JSON.stringify(scene)).toBe(before); expect(normalizePhysicalDraftingScene(scene, 'positive-y')).toBe(scene)
})
test('presentation bounds may exceed physical walls, and fit follows actual floor/scope/layer selection', () => {
  expect(packPhysicalSceneSchema.safeParse(scene).success).toBe(true)
  const view = defaultPhysicalSceneView(scene.levels)
  expect(physicalPlanDrawingBounds(scene, view, 'room')).toEqual({ min: [-2, -2, 0], max: [6, 0, 0] })
  expect(visiblePhysicalPlanDrawing(scene, { ...view, hiddenLayerIds: ['notes'] }, 'room')).toEqual([])
  expect(visiblePhysicalPlanDrawing(scene, { ...view, mode: '3d' }, 'room')).toEqual([])
  expect(visiblePhysicalPlanDrawing(scene, view, 'absent')).toEqual([])
  expect(visiblePhysicalPlanDrawing(scene, view, 'room')).toBe(visiblePhysicalPlanDrawing(scene, view, 'room'))
})
test('native Plan uses an exact nonsingular affine frame for source-local curves, including north-up screen reflection', () => {
  expect(physicalPlanFrame([{ x: 10, y: 20 }, { x: 12, y: 20 }, { x: 10, y: 18 }])).toEqual({ a: 2, b: 0, c: 0, d: -2, e: 10, f: 20 })
  expect(physicalPlanFrame([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull()
})
