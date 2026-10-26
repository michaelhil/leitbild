import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { buildVisibleMeshes } from '../src/ui/map/physical-scene/geometry.ts'
import { visiblePhysicalInspectionBoundaries } from '../src/ui/map/physical-scene/inspection-cutaway.ts'
import { multiply } from '../src/ui/map/physical-scene/math.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const wall: PhysicalSceneObject = {
  id: 'enclosure', label: 'High bay enclosure', kind: 'wall', levelId: 'ground', subjectIds: [], edgePolicy: 'authored',
  bounds: { min: [0, 0, 0], max: [10, .4, 30] }, inspectionBoundary: { outward: [0, -1, 0] },
  inspectionLevels: [{ levelId: 'ground', low: 0, high: 15 }, { levelId: 'operating', low: 15, high: 32 }],
  positions: [0, 0, 0, 10, 0, 0, 10, 0, 30, 0, 0, 0, 10, 0, 30, 0, 0, 30],
}
const scene: PackPhysicalScene = {
  id: 'unit', revision: 'authored', targetObjectId: 'plant', anchor: [0, 0], bearing: 0,
  bounds: { min: [0, 0, 0], max: [10, 10, 32] },
  levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 1.2 }, { id: 'service', label: 'Service elsewhere', elevation: 8, cutHeight: 9.2 }, { id: 'operating', label: 'Operating', elevation: 15, cutHeight: 16.2 }, { id: 'refuelling', label: 'Refuelling elsewhere', elevation: 22, cutHeight: 23.2 }], objects: [wall],
}
const camera = (y: number) => {
  const near = 1, far = 100, projection = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0])
  return multiply(projection, new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -y, -40, 1]))
}
test('an authored high bay keeps its actual ceiling rather than another building’s global floor', () => {
  const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'operating' }
  const meshes = buildVisibleMeshes(scene, view)
  expect(meshes.map(mesh => mesh.inspectionPart)).toEqual(['full', 'cut'])
  expect(meshes.find(mesh => mesh.inspectionPart === 'full')!.bounds.max[2]).toBe(30)
  expect(meshes.find(mesh => mesh.inspectionPart === 'cut')!.bounds.max[2]).toBe(16.2)
  expect(buildVisibleMeshes(scene, { ...view, levelId: 'service' })).toEqual([])
  const plan = buildVisibleMeshes(scene, { ...view, mode: '2d' })
  expect(plan).toHaveLength(1); expect(plan[0]!.inspectionPart).toBeUndefined(); expect(plan[0]!.bounds.max[2]).toBe(16.2)
})
test('orbit selects exact full rear or cut foreground boundaries without preparing another view', () => {
  const before = JSON.stringify(scene), meshes = buildVisibleMeshes(scene, { ...defaultPhysicalSceneView(scene.levels), mode: '3d', levelId: 'all' })
  const foreground = visiblePhysicalInspectionBoundaries(meshes, camera(-20)), rear = visiblePhysicalInspectionBoundaries(meshes, camera(20))
  expect(foreground.map(mesh => mesh.inspectionPart)).toEqual(['cut'])
  expect(foreground[0]!.bounds.max[2]).toBe(1.2)
  expect(rear.map(mesh => mesh.inspectionPart)).toEqual(['full']); expect(rear[0]!.bounds.max[2]).toBe(30)
  expect(visiblePhysicalInspectionBoundaries(meshes, camera(30))).toBe(rear)
  expect(foreground[0]!.object).toBe(rear[0]!.object); expect(JSON.stringify(scene)).toBe(before)
})
test('retained profiles without boundary metadata keep their existing section and inspection semantics', () => {
  const { inspectionBoundary: _boundary, inspectionLevels: _levels, ...retained } = wall
  const meshes = buildVisibleMeshes({ ...scene, objects: [retained] }, { ...defaultPhysicalSceneView(scene.levels), mode: '3d', levelId: 'operating' })
  expect(meshes).toHaveLength(1); expect(meshes[0]!.inspectionPart).toBeUndefined(); expect(meshes[0]!.bounds.max[2]).toBe(16.2)
  expect(visiblePhysicalInspectionBoundaries(meshes, camera(-20))).toBe(meshes)
})
