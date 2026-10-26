import { expect, test } from 'bun:test'
import { packPhysicalSceneSchema, type PackPhysicalScene, type PhysicalSceneObject } from '../src/core/packs/scene.ts'
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
  const length = Math.hypot(y, 40), by = y / length, bz = 40 / length
  return multiply(projection, new Float64Array([1, 0, 0, 0, 0, bz, by, 0, 0, -by, bz, 0, 0, 0, -length, 1]))
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
  expect(foreground.map(mesh => mesh.inspectionPart)).toEqual(['cut', 'cut'])
  expect(foreground[0]!.bounds.max[2]).toBe(1.2)
  expect(foreground[1]!.bounds).toEqual({ min: [0, 0, 15], max: [10, 0, 16.2] })
  expect(foreground[1]!.levelId).toBe('operating')
  expect(new Set(foreground.map(mesh => mesh.key)).size).toBe(2)
  expect(rear.map(mesh => mesh.inspectionPart)).toEqual(['full']); expect(rear[0]!.bounds.max[2]).toBe(30)
  expect(visiblePhysicalInspectionBoundaries(meshes, camera(30))).toBe(rear)
  expect(foreground[0]!.object).toBe(rear[0]!.object); expect(JSON.stringify(scene)).toBe(before)
})
test('All keeps floor-local low walls at true elevations without phantom floors or source duplication', () => {
  const before = JSON.stringify(scene), view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'all' }
  const cuts = buildVisibleMeshes(scene, view).filter(mesh => mesh.inspectionPart === 'cut')
  expect(cuts.map(mesh => [mesh.levelId, mesh.bounds.min[2], mesh.bounds.max[2]])).toEqual([['ground', 0, 1.2], ['operating', 15, 16.2]])
  expect(cuts.every(mesh => mesh.offset.every(value => value === 0) && mesh.object === wall)).toBe(true)
  expect(cuts.every(mesh => [...mesh.vertices].every((value, index) => index % 7 !== 2 || value >= mesh.bounds.min[2] && value <= mesh.bounds.max[2]))).toBe(true)
  expect(JSON.stringify(scene)).toBe(before)
  const isolated = buildVisibleMeshes(scene, { ...view, levelId: 'operating' }).filter(mesh => mesh.inspectionPart === 'cut')
  expect(isolated).toHaveLength(1); expect(isolated[0]!.bounds.min[2]).toBe(15)
})
test('retained profiles without boundary metadata keep their existing section and inspection semantics', () => {
  const { inspectionBoundary: _boundary, inspectionLevels: _levels, ...retained } = wall
  const meshes = buildVisibleMeshes({ ...scene, objects: [retained] }, { ...defaultPhysicalSceneView(scene.levels), mode: '3d', levelId: 'operating' })
  expect(meshes).toHaveLength(1); expect(meshes[0]!.inspectionPart).toBeUndefined(); expect(meshes[0]!.bounds.max[2]).toBe(16.2)
  expect(visiblePhysicalInspectionBoundaries(meshes, camera(-20))).toBe(meshes)
})
test('new inspection volumes use exact floor boundaries and the full actual thickness of the owning slab', () => {
  const slab: PhysicalSceneObject = { ...wall, id: 'thick-deck', kind: 'slab', levelId: 'operating', inspectionBoundary: undefined, positions: [0, 0, 12, 10, 0, 12, 10, .4, 15, 0, 0, 12, 10, .4, 15, 0, .4, 15], bounds: { min: [0, 0, 12], max: [10, .4, 15] } }
  const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'operating' }
  const meshes = buildVisibleMeshes({ ...scene, objects: [slab, wall] }, view)
  expect(meshes.find(mesh => mesh.object.id === slab.id)!.bounds.min[2]).toBe(12)
  expect(meshes.filter(mesh => mesh.object.id === wall.id).every(mesh => mesh.bounds.min[2] === 15)).toBe(true)
  const lower = buildVisibleMeshes(scene, { ...view, levelId: 'ground' })
  expect(lower.every(mesh => mesh.bounds.min[2] === 0)).toBe(true)
  expect(packPhysicalSceneSchema.safeParse({ ...scene, objects: [{ ...wall, inspectionLevels: [] }] }).success).toBe(false)
})
test('authored structural Plan sections omit overhead framing while machinery projections keep their full silhouette', () => {
  const overhead: PhysicalSceneObject = { ...wall, id: 'roof-beam', kind: 'support', inspectionBoundary: undefined, planDisplay: 'section', positions: [0, 0, 28, 10, 0, 28, 10, .4, 29] }
  const machine: PhysicalSceneObject = { ...overhead, id: 'machine-fitting', planDisplay: 'projection' }
  const value = { ...scene, objects: [overhead, machine] }, plan = { ...defaultPhysicalSceneView(scene.levels), levelId: 'operating' }
  expect(buildVisibleMeshes(value, plan).map(mesh => mesh.object.id)).toEqual(['machine-fitting'])
  expect(buildVisibleMeshes(value, { ...plan, mode: '3d' }).map(mesh => mesh.object.id)).toEqual(['roof-beam', 'machine-fitting'])
})
