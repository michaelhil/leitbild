import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { buildVisibleMeshes, type PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
import { physicalSurfaceAnnotations } from '../src/ui/map/physical-scene/surface-annotations.ts'
import { visiblePhysicalSurfaceOwners } from '../src/ui/map/physical-scene/surface-ownership.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import { physicalMaterialColor } from '../src/ui/map/physical-scene/backend.ts'
import { pickPhysicalMesh } from '../src/ui/map/physical-scene/picking.ts'

const plate = (id: string, minX: number, maxX: number): PhysicalSceneObject => ({ id, label: id, kind: 'slab', levelId: 'floor', positions: [minX, -2, 0, maxX, -2, 0, maxX, 2, 0, minX, -2, 0, maxX, 2, 0, minX, 2, 0], material: 'floor', subjectIds: [], scopeIds: ['site', 'building'], edgePolicy: 'none' })
const source = (): PackPhysicalScene => ({ id: 'layout', revision: 'exact-source', targetObjectId: 'owner', anchor: [0, 0], bearing: 0, bounds: { min: [-3, -2, 0], max: [3, 2, 0] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 1 }], layers: [{ id: 'allowances', label: 'Illustrative work areas', defaultVisible: true }], objects: [plate('left-floor', -2, -.5), plate('right-floor', .5, 2)], planAnnotations: [{ id: 'work-area', kind: 'hatch', role: 'laydown', levelIds: ['floor'], scopeIds: ['site', 'building'], layerId: 'allowances', basis: 'illustrative', label: 'Unqualified work area', outline: [[-3, -1, 0], [3, -1, 0], [3, 1, 0], [-3, 1, 0], [-3, -1, 0]] }] })
const surfaceArea = (meshes: ReadonlyArray<PhysicalMesh>): number => meshes.reduce((total, mesh) => {
  for (let at = 0; at < mesh.vertices.length; at += 21) { const v = mesh.vertices; total += Math.abs((v[at + 7]! - v[at]!) * (v[at + 15]! - v[at + 1]!) - (v[at + 8]! - v[at + 1]!) * (v[at + 14]! - v[at]!)) / 2 }
  return total
}, 0)

test('work areas decorate exact floor faces, preserve shaft openings and restore floor ownership when hidden', () => {
  const scene = source(), before = JSON.stringify(scene), view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const }, prepared = preparePhysicalGeometry(scene, view, 'prepared')
  const shown = visiblePhysicalSurfaceOwners(prepared.meshes), hidden = visiblePhysicalSurfaceOwners(prepared.meshes.filter(mesh => mesh.annotation?.layerId !== 'allowances'))
  expect(surfaceArea(shown)).toBeCloseTo(12, 8)
  expect(surfaceArea(shown.filter(mesh => mesh.annotation !== undefined))).toBeCloseTo(6, 8)
  expect(surfaceArea(hidden)).toBeCloseTo(12, 8)
  expect(hidden.every(mesh => mesh.annotation === undefined)).toBe(true)
  for (const mesh of shown.filter(mesh => mesh.annotation)) {
    expect(scene.objects.includes(mesh.object)).toBe(true)
    expect(mesh.annotation).toEqual({ id: 'work-area', layerId: 'allowances', scopeIds: ['site', 'building'] })
    for (let at = 2; at < mesh.vertices.length; at += 7) expect(mesh.vertices[at]).toBe(0)
    expect(mesh.lines.length).toBe(0) // Hatch is a material, not another coincident line surface.
  }
  const matrix = new Float64Array([.25, 0, 0, 0, 0, .25, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])
  const pick = (meshes: ReadonlyArray<PhysicalMesh>, x: number) => pickPhysicalMesh([{ sceneId: scene.id, meshes, matrix }], { x, y: 50 }, 100, 100)?.mesh.object.id
  expect(pick(shown, 35)).toBe('left-floor')
  expect(pick(hidden, 35)).toBe('left-floor')
  expect(pick(shown, 50)).toBeUndefined()
  expect(JSON.stringify(scene)).toBe(before)
})

test('floor decoration is optional 3D illustration and never becomes a second Plan projection', () => {
  const scene = source(), plan = defaultPhysicalSceneView(scene.levels), meshes = buildVisibleMeshes(scene, plan)
  expect(physicalSurfaceAnnotations(scene, plan, meshes)).toBe(meshes)
  const other = { ...scene, levels: [...scene.levels, { id: 'other', label: 'Other', elevation: 4, cutHeight: 5 }] }
  expect(physicalSurfaceAnnotations(other, { ...plan, mode: '3d', levelId: 'other' }, meshes)).toBe(meshes)
})

test('illustrative colour composites against the actual floor material before lighting', () => {
  const palette = { materials: { floor: [.8, .8, .7] as const, access: [.5, .7, .5] as const, outage: [.8, .7, .4] as const }, defaultMaterial: [.3, .4, .3] as const, line: [.2, .3, .2] as const }
  expect(physicalMaterialColor(palette, 'floor')).toEqual(palette.materials.floor)
  const expected = palette.materials.floor.map((value, axis) => value * .58 + palette.materials.access[axis]! * .42)
  expect([...physicalMaterialColor(palette, 'surface/access/floor')]).toEqual(expected)
  expect(() => physicalMaterialColor(palette, 'surface/alarm/floor')).toThrow('Invalid physical surface decoration')
})

test('outdoor work surfaces remain independent of a selected indoor floor', () => {
  const scene = source()
  scene.objects = scene.objects.map(object => ({ ...object, levelId: 'site' }))
  scene.planAnnotations = scene.planAnnotations!.map(annotation => ({ ...annotation, levelIds: ['site'] }))
  const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'floor' }
  const meshes = physicalSurfaceAnnotations(scene, view, buildVisibleMeshes(scene, view))
  expect(meshes.some(mesh => mesh.annotation?.id === 'work-area')).toBe(true)
  expect(meshes.filter(mesh => mesh.annotation).every(mesh => mesh.object.levelId === 'site' && mesh.offset[2] === 0)).toBe(true)
})
