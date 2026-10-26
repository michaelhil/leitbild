import { expect, test } from 'bun:test'
import { packPhysicalSceneSchema, type PackPhysicalScene, type PhysicalPlanAnnotation } from '../src/core/packs/scene.ts'
import { visiblePhysicalPlanAnnotations, physicalPlanDimensionText } from '../src/ui/physical-layout/plan-annotations.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const annotation: PhysicalPlanAnnotation = { id: 'room-name', kind: 'label', role: 'space', text: 'Turbine hall', anchor: [5, 4, 0], rotation: 0, levelIds: ['ground'], scopeIds: ['hall'], layerId: 'drafting' }
const scene: PackPhysicalScene = {
  id: 'layout', revision: 'exact', targetObjectId: 'plant', anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [10, 10, 10] },
  levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 2 }, { id: 'upper', label: 'Upper', elevation: 5, cutHeight: 7 }],
  scopes: [{ id: 'building', kind: 'building', label: 'Building', bounds: { min: [0, 0, 0], max: [10, 10, 10] }, levelIds: ['ground', 'upper'] }, { id: 'hall', kind: 'space', label: 'Hall', parentId: 'building', bounds: { min: [0, 0, 0], max: [10, 10, 10] }, levelIds: ['ground'] }],
  layers: [{ id: 'drafting', label: 'Architectural labels', defaultVisible: true }], objects: [], planAnnotations: [annotation],
}
test('authored drafting follows floor, selected scope and information-layer visibility without changing source', () => {
  const before = JSON.stringify(scene), view = defaultPhysicalSceneView(scene.levels)
  expect(visiblePhysicalPlanAnnotations(scene, view, null)).toEqual([annotation])
  expect(visiblePhysicalPlanAnnotations(scene, view, 'building')).toEqual([annotation])
  expect(visiblePhysicalPlanAnnotations(scene, view, 'other')).toEqual([])
  expect(visiblePhysicalPlanAnnotations(scene, { ...view, levelId: 'upper' }, null)).toEqual([])
  expect(visiblePhysicalPlanAnnotations(scene, { ...view, hiddenLayerIds: ['drafting'] }, null)).toEqual([])
  expect(visiblePhysicalPlanAnnotations(scene, { ...view, mode: '3d' }, null)).toEqual([])
  expect(JSON.stringify(scene)).toBe(before)
})
test('a dimension value is derived from its source witnesses, including a rotated measurement', () => {
  const dimension = { id: 'width', kind: 'dimension' as const, levelIds: ['ground'], scopeIds: ['hall'], from: [1, 2, 0] as [number, number, number], to: [4, 6, 0] as [number, number, number], offset: [0, 1, 0] as [number, number, number], unit: 'm' as const }
  expect(physicalPlanDimensionText(dimension)).toBe('5 m')
  expect(physicalPlanDimensionText({ ...dimension, to: [7, 10, 0] })).toBe('10 m')
})
test('the scene boundary rejects drafting with unknown authority or invalid illustrative geometry', () => {
  expect(packPhysicalSceneSchema.safeParse(scene).success).toBe(true)
  for (const invalid of [{ ...annotation, levelIds: ['missing'] }, { ...annotation, scopeIds: ['missing'] }, { ...annotation, occurrenceId: 'missing' }, { ...annotation, layerId: 'missing' }]) {
    expect(packPhysicalSceneSchema.safeParse({ ...scene, planAnnotations: [invalid] }).success).toBe(false)
  }
  expect(packPhysicalSceneSchema.safeParse({ ...scene, planAnnotations: [{ id: 'allowance', levelIds: ['ground'], scopeIds: ['hall'], kind: 'hatch', role: 'laydown', outline: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], label: 'Illustrative allowance', basis: 'illustrative' }] }).success).toBe(false)
})
