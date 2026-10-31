import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneBounds } from '../src/core/packs/scene.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { visiblePhysicalSurfaceOwners } from '../src/ui/map/physical-scene/surface-ownership.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import { pickPhysicalMesh } from '../src/ui/map/physical-scene/picking.ts'
import type { PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
import { scopeRouteFixture as tube } from './fixtures/physical-scope-route.ts'

const scene = (regions: PhysicalSceneBounds[]): PackPhysicalScene => ({ id: 'layout', revision: 'source', targetObjectId: 'plant', anchor: [0, 0], bearing: 0, bounds: { min: [-5, -5, -5], max: [5, 5, 5] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 1.2 }], objects: [tube()], scopes: [
  { id: 'unit', label: 'Unit', kind: 'unit', levelIds: ['floor'], bounds: { min: [-5, -5, -5], max: [5, 5, 5] } },
  ...regions.map((bounds, index) => ({ id: `room-${index}`, label: `Room ${index}`, kind: 'space' as const, parentId: 'unit', levelIds: ['floor'], bounds })),
  { id: 'area', label: 'Inspection area', kind: 'area', parentId: 'unit', levelIds: ['floor'], members: regions.map((_, index) => `room-${index}`), bounds: { min: [-5, -5, -5], max: [5, 5, 5] } },
] })
const areaOnPlane = (meshes: ReadonlyArray<PhysicalMesh>, axis: number, coordinate: number) => {
  let total = 0
  for (const mesh of meshes) for (let at = 0; at < mesh.vertices.length; at += 21) {
    const v = mesh.vertices
    if (![at, at + 7, at + 14].every(index => v[index + axis] === coordinate)) continue
    const u = [v[at + 7]! - v[at]!, v[at + 8]! - v[at + 1]!, v[at + 9]! - v[at + 2]!], w = [v[at + 14]! - v[at]!, v[at + 15]! - v[at + 1]!, v[at + 16]! - v[at + 2]!]
    total += Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2
  }
  return total
}
const prepare = (source: PackPhysicalScene, scopeId?: string) => {
  const view = { ...defaultPhysicalSceneView(source.levels), mode: '3d' as const, levelId: 'all', ...(scopeId ? { scopeId } : {}) }
  const prepared = preparePhysicalGeometry(source, view, scopeId ?? 'whole')
  return visiblePhysicalSurfaceOwners(prepared.meshes)
}

test('a room clips a transiting route to its real envelope, caps both ends and preserves source/graph/pick identity', () => {
  const source = scene([{ min: [-1, -1, 0], max: [1, 1, 3] }]), before = JSON.stringify(source), full = prepare(source), clipped = prepare(source, 'room-0')
  expect(Math.min(...full.flatMap(mesh => [mesh.bounds.min[0]]))).toBe(-4)
  expect(Math.max(...clipped.flatMap(mesh => [mesh.bounds.max[0]]))).toBe(1)
  expect(Math.min(...clipped.flatMap(mesh => [mesh.bounds.min[0]]))).toBe(-1)
  expect(clipped.every(mesh => mesh.object === source.objects[0] && mesh.inspectionScopeId === 'room-0')).toBe(true)
  const polygonArea = 16 / 2 * .5 ** 2 * Math.sin(Math.PI * 2 / 16)
  expect(areaOnPlane(clipped, 0, -1)).toBeCloseTo(polygonArea, 10)
  expect(areaOnPlane(clipped, 0, 1)).toBeCloseTo(polygonArea, 10)
  expect(clipped.some(mesh => mesh.materials?.some(role => role.startsWith('continuation/pipe/')))).toBe(true)
  const matrix = new Float64Array([0, 0, -.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 1])
  expect(pickPhysicalMesh([{ sceneId: source.id, meshes: clipped, matrix }], { x: 50, y: 50 }, 100, 100)?.mesh.object.subjectIds).toEqual(['supply-edge'])
  expect(JSON.stringify(source)).toBe(before)
})

test('area members form their union: no geometry in gaps and no continuation caps on shared internal faces', () => {
  const disjoint = prepare(scene([{ min: [-3, -1, 0], max: [-1, 1, 3] }, { min: [1, -1, 0], max: [3, 1, 3] }]), 'area')
  for (const coordinate of [-3, -1, 1, 3]) expect(areaOnPlane(disjoint, 0, coordinate)).toBeGreaterThan(0)
  for (const mesh of disjoint) for (let at = 0; at < mesh.vertices.length; at += 21) expect([at, at + 7, at + 14].every(index => mesh.vertices[index]! <= -1) || [at, at + 7, at + 14].every(index => mesh.vertices[index]! >= 1)).toBe(true)
  const joined = prepare(scene([{ min: [-3, -1, 0], max: [1, 1, 3] }, { min: [-1, -1, 0], max: [3, 1, 3] }]), 'area')
  expect(areaOnPlane(joined, 0, -3)).toBeGreaterThan(0); expect(areaOnPlane(joined, 0, 3)).toBeGreaterThan(0)
  expect(areaOnPlane(joined, 0, -1)).toBe(0); expect(areaOnPlane(joined, 0, 1)).toBe(0)
})

test('intersecting cut planes close the real half-tube instead of inventing a shifted full cap', () => {
  const clipped = prepare(scene([{ min: [-1, 0, 0], max: [1, 1, 3] }]), 'room-0')
  expect(areaOnPlane(clipped, 1, 0)).toBeCloseTo(2, 10)
  expect(areaOnPlane(clipped, 0, 1)).toBeCloseTo(16 / 4 * .5 ** 2 * Math.sin(Math.PI * 2 / 16), 10)
  for (const mesh of clipped) for (let at = 0; at < mesh.vertices.length; at += 7) expect(mesh.vertices[at + 1]!).toBeGreaterThanOrEqual(0)
})

test('selected floor cuts reconstruct both real tube caps from closed source geometry', () => {
  const source = scene([{ min: [-1, -1, -5], max: [1, 2, 5] }]), object = source.objects[0]! as ReturnType<typeof tube>
  const rotate = (values: ReadonlyArray<number>) => values.flatMap((_, index) => index % 3 ? [] : [values[index + 1]!, values[index + 2]!, values[index]!])
  object.positions = rotate(object.positions as number[]); object.normals = rotate(object.normals as number[])
  object.bounds = { min: [-.5, .5, -4], max: [.5, 1.5, 4] }
  object.spatialPath = { radius: .5, points: [[0, 1, -4], [0, 1, 4]] }
  object.levelId = 'lower'; object.levelIds = ['lower', 'upper']; object.inspectionLevels = [{ levelId: 'lower', low: 0, high: 1.5 }, { levelId: 'upper', low: 1.5, high: 3 }]
  source.levels = [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: .6 }, { id: 'upper', label: 'Upper', elevation: 1.5, cutHeight: 2.1 }]
  const prepared = preparePhysicalGeometry(source, { ...defaultPhysicalSceneView(source.levels), mode: '3d', levelId: 'upper' }, 'upper'), meshes = visiblePhysicalSurfaceOwners(prepared.meshes)
  expect(Math.min(...meshes.map(mesh => mesh.bounds.min[2]))).toBe(1.5)
  expect(Math.max(...meshes.map(mesh => mesh.bounds.max[2]))).toBe(3)
  const polygonArea = 16 / 2 * .5 ** 2 * Math.sin(Math.PI * 2 / 16)
  expect(areaOnPlane(meshes, 2, 1.5)).toBeCloseTo(polygonArea, 10)
  expect(areaOnPlane(meshes, 2, 3)).toBeCloseTo(polygonArea, 10)
})

test('every admitted PWR floor and the exploded whole unit retain closed true cuts without recapping source extrema', async () => {
  const { resolvePhysicalDesign, pwrDraftingUnitPhysicalDesignRef } = await import('../src/packs/physical-layout/design.ts')
  const { compilePhysicalScene } = await import('../src/packs/physical-layout/native/drafting/compile-scene.ts')
  const { buildVisibleMeshes } = await import('../src/ui/map/physical-scene/geometry.ts')
  const { clipPhysicalMeshesToScope } = await import('../src/ui/map/physical-scene/scope-clipping.ts')
  const design = await resolvePhysicalDesign(pwrDraftingUnitPhysicalDesignRef)
  if (design.profile !== 'drafting') throw Error('The qualification requires the admitted drafting source')
  const scene = compilePhysicalScene('admitted-pwr-floor-qualification', { ...design, owner: { objectId: 'plant' }, placement: { anchor: [11.47, 59.087], bearing: 0 }, bounds: design.presentation.scopes[0]!.bounds })
  for (const levelId of ['all', ...scene.levels.map(level => level.id)]) for (const separation of levelId === 'all' ? [0, 1] : [0]) {
    const view = { mode: '3d' as const, levelId, cutaway: true, separation, detail: 'auto' as const, live: false, hiddenLayerIds: [] }
    const before = buildVisibleMeshes(scene, view), clipped = clipPhysicalMeshesToScope(scene, view, before)
    expect(clipped.length).toBeGreaterThan(0)
    for (const mesh of clipped.filter(mesh => mesh.object.clipToScope)) {
      expect(scene.objects.includes(mesh.object)).toBe(true)
      expect(mesh.vertices.every(Number.isFinite)).toBe(true)
    }
  }
})
