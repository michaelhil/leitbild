import { expect, test } from 'bun:test'
import type { PackPhysicalScene, PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import { projectPhysicalPlan } from '../src/ui/map/physical-scene/plan-projection.ts'
import { inverse, localMercatorMatrix, multiply, transform } from '../src/ui/map/physical-scene/math.ts'
import { pickPhysicalMesh } from '../src/ui/map/physical-scene/picking.ts'

const plate = (id: string, z: number, kind = 'context', x = -.8, y = -.8, size = 1.6): PhysicalSceneObject => ({ id, label: id, kind, levelId: 'site', subjectIds: [], edgePolicy: 'none', positions: [x, y, z, x + size, y, z, x + size, y + size, z, x, y, z, x + size, y + size, z, x, y + size, z] })
const source = (height: number): PackPhysicalScene => ({ id: 'layout', targetObjectId: 'owner', revision: 'r', anchor: [0, 0], bearing: 0, bounds: { min: [-.8, -.8, 0], max: [.8, .8, height] }, levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 2 }], objects: [plate('base', 0), plate('raised-detail', .012), plate('true-coplanar-second', .012), plate('remote-height', height, 'context', .6, .6, .2)] })
const frame = (height: number, distance: number, zoom: number) => {
  const scene = source(height), view = defaultPhysicalSceneView(scene.levels), asset = preparePhysicalGeometry(scene, view, 'plan')
  const desired = new Float64Array([distance * zoom, 0, 0, 0, 0, distance * zoom, 0, 0, 0, 0, 1, 0, 0, 0, 0, distance])
  const matrix = multiply(desired, inverse(localMercatorMatrix(scene.anchor, scene.bearing)))
  return { scene, asset, projected: projectPhysicalPlan([{ scene, meshes: asset.meshes, asset, view, status: new Map() }], matrix), desired }
}

test('Plan preserves authored surface order and exact coplanar identity at both near and regional camera scales', () => {
  for (const height of [1, 100, 10_000]) for (const distance of [.001, 1, 1000]) for (const zoom of [.1, 1, 10]) {
    const { projected } = frame(height, distance, zoom), value = projected[0]!
    const hit = pickPhysicalMesh([{ sceneId: 'layout', meshes: value.meshes, matrix: value.matrix }], { x: 50, y: 50 }, 100, 100)
    expect(hit?.mesh.object.id).toBe('raised-detail')
    const depth = (id: string) => { const mesh = value.meshes.find(candidate => candidate.object.id === id)!; return transform(value.matrix, [0, 0, mesh.vertices[2]! + mesh.offset[2]])[2] }
    const base = Math.round((depth('base') / 2 + .5) * (2 ** 24 - 1)), raised = Math.round((depth('raised-detail') / 2 + .5) * (2 ** 24 - 1))
    expect(base - raised).toBeGreaterThan(1)
  }
})

test('Plan XY uses geographic ground for all heights; semantic bands remain disjoint and source geometry is unchanged', () => {
  const { scene, asset, projected, desired } = frame(100, 1, 1), before = JSON.stringify(scene), value = projected[0]!
  expect(asset.meshes.find(mesh => mesh.object.id === 'raised-detail')!.vertices[2]).toBe(.012)
  const low = transform(value.matrix, [.2, .3, 0]), high = transform(value.matrix, [.2, .3, 1000]), ground = transform(desired, [.2, .3, 0])
  expect(low.slice(0, 2)).toEqual(high.slice(0, 2)); expect(low.slice(0, 2)).toEqual(ground.slice(0, 2))
  const withWall = { ...scene, objects: [plate('high-floor', 100, 'slab'), plate('low-wall', 0, 'wall')] }
  const view = defaultPhysicalSceneView(withWall.levels), prepared = preparePhysicalGeometry(withWall, view, 'bands'), matrix = inverse(localMercatorMatrix(scene.anchor, scene.bearing))
  const bands = projectPhysicalPlan([{ scene: withWall, meshes: prepared.meshes, asset: prepared, view, status: new Map() }], matrix)[0]!
  expect(pickPhysicalMesh([{ sceneId: 'layout', meshes: bands.meshes, matrix: bands.matrix }], { x: 50, y: 50 }, 100, 100)?.mesh.object.id).toBe('low-wall')
  expect(JSON.stringify(scene)).toBe(before)
})

test('a natively pitched host keeps Plan on geographic ground with stable height order under nonconstant W', () => {
  const scene = source(100), view = defaultPhysicalSceneView(scene.levels), asset = preparePhysicalGeometry(scene, view, 'pitched-plan')
  const camera = new Float64Array([.7, 0, 0, 0, 0, .5, 0, .35, .2, .3, .2, .1, 0, 0, 0, 1])
  const value = projectPhysicalPlan([{ scene, meshes: asset.meshes, asset, view, status: new Map() }], multiply(camera, inverse(localMercatorMatrix(scene.anchor, scene.bearing))))[0]!
  for (const x of [-.7, 0, .7]) for (const y of [-.7, 0, .7]) {
    const point = transform(value.matrix, [x, y, 0]), high = transform(value.matrix, [x, y, 100]), ground = transform(camera, [x, y, 0])
    expect(point.slice(0, 2)).toEqual(high.slice(0, 2)); expect(point[0]).toBeCloseTo(ground[0], 7); expect(point[1]).toBeCloseTo(ground[1], 7)
    const hit = pickPhysicalMesh([{ sceneId: 'layout', meshes: value.meshes, matrix: value.matrix }], { x: (point[0] + 1) * 50, y: (1 - point[1]) * 50 }, 100, 100)
    expect(hit?.mesh.object.id).toBe(x >= .6 && y >= .6 ? 'remote-height' : 'raised-detail')
  }
})
