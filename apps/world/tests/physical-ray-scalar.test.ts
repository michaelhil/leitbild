import { expect, test } from 'bun:test'
import { rayBox, rayBoxCoordinates, rayTriangle, rayTrianglePacked, transform, type Vector3 } from '../src/ui/map/physical-scene/math.ts'
import { rayBox as priorBox, rayTriangle as priorTriangle } from './fixtures/physical-layout/ray-math-before-scalar.ts'
import { createPhysicalSpatialIndex, visitPhysicalSpatialRay } from '../src/ui/map/physical-scene/spatial-index.ts'
import { visitPhysicalSpatialRay as priorVisit } from './fixtures/physical-layout/spatial-index-before-scalar.ts'
import { pickPhysicalMesh, type PhysicalPickEntry } from '../src/ui/map/physical-scene/picking.ts'
import { pickPhysicalMesh as priorPick } from './fixtures/physical-layout/picking-before-scalar.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import definitionSource from '../src/scenarios/halden-normal-operation.scenario.json'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../src/packs/physical-layout/scene.ts'
import { preparePhysicalGeometry } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import { visiblePhysicalInspectionBoundaries } from '../src/ui/map/physical-scene/inspection-cutaway.ts'
import { visiblePhysicalSurfaceOwners } from '../src/ui/map/physical-scene/surface-ownership.ts'
import { physicalArchitectureOpacity } from '../src/ui/map/physical-scene/architecture-opacity.ts'

let seed = 1072726
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const vector = (scale = 10): Vector3 => [(random() - .5) * scale, (random() - .5) * scale, (random() - .5) * scale]
const equalNumber = (actual: number | null, expected: number | null): void => { expect(Object.is(actual, expected)).toBe(true) }

test('packed and generic triangle rays preserve every original scalar predicate and floating result', () => {
  const triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as const
  const inputs: Array<{ a: Vector3; b: Vector3; c: Vector3; origin: Vector3; direction: Vector3 }> = []
  for (const origin of [[0, 0, 1], [.5, 0, 1], [.2, .2, 1], [.2, .2, 0], [-0, 0, 0], [1, 1, 1], [0, 0, -1]] as const) for (const direction of [[0, 0, -1], [0, -0, 1], [0, 0, 0], [1, 0, 0], [1, 0, -1e-10], [0, 0, -1e-9], [0, 0, -1.00000000001e-9]] as const) inputs.push({ a: triangle[0], b: triangle[1], c: triangle[2], origin, direction })
  inputs.push({ a: [0, 0, 0], b: [1, 0, 0], c: [2, 0, 0], origin: [0, 0, 1], direction: [0, 0, -1] })
  inputs.push({ a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0], origin: [NaN, 0, 1], direction: [0, 0, -1] })
  for (let index = 0; index < 4_096; index++) inputs.push({ a: vector(), b: vector(), c: vector(), origin: vector(), direction: vector(2) })
  for (const { a, b, c, origin, direction } of inputs) {
    const expected = priorTriangle(origin, direction, a, b, c), packed = new Float64Array([99, ...a, -0, 0, 1, 3, ...b, 0, -0, 1, 2, ...c, 0, 0, 1, 1])
    equalNumber(rayTriangle(origin, direction, a, b, c), expected); equalNumber(rayTrianglePacked(origin, direction, packed, 1), expected)
  }
})

test('scalar boxes preserve parallel/grazing/inside and signed-zero results at the original tolerance', () => {
  const boxes = [{ min: [-1, -2, -3] as [number, number, number], max: [1, 2, 3] as [number, number, number] }, { min: [0, -0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] }]
  for (const bounds of boxes) for (const origin of [[0, 0, 0], [1, 2, 3], [-1, -2, -3], [2, 0, 0]] as const) for (const direction of [[0, 0, 0], [1, 0, 0], [-1, -0, 0], [1e-10, 0, 1], [9.999999999e-11, -1, 0]] as const) {
    const expected = priorBox(origin, direction, bounds)
    equalNumber(rayBox(origin, direction, bounds), expected); equalNumber(rayBoxCoordinates(origin, direction, ...bounds.min, ...bounds.max), expected)
  }
})

test('cached scalar BVH distances preserve exact visitation and nearest-callback order under changing nearest bounds', () => {
  const bounds = Array.from({ length: 193 }, () => { const min = [...vector(40)] as [number, number, number]; return { min, max: min.map(value => value + random() * 8) as [number, number, number] } }), index = createPhysicalSpatialIndex(bounds)
  const run = (visit: typeof visitPhysicalSpatialRay, origin: Vector3, direction: Vector3, changes: boolean) => {
    const ids: number[] = [], nearestCalls: number[] = []; let nearest = Infinity
    visit(index, origin, direction, () => { nearestCalls.push(nearest); return nearest }, id => { ids.push(id); if (changes) nearest = Math.min(nearest, id % 11) })
    return { ids, nearestCalls }
  }
  for (const origin of [[0, 0, 0] as Vector3, ...Array.from({ length: 30 }, () => vector(40))]) for (const direction of [[0, 0, 1] as Vector3, [-0, 1, 0] as Vector3, [1e-10, 0, -1] as Vector3, vector(2)]) for (const changes of [false, true]) expect(run(visitPhysicalSpatialRay, origin, direction, changes)).toEqual(run(priorVisit, origin, direction, changes))
})

test('BVH forward-error reservation keeps the same grazing/inside/zero-direction leaf order', () => {
  const bounds = Array.from({ length: 16 }, (_, index) => ({ min: [index * 3, 0, -1] as [number, number, number], max: [index * 3 + 1, 1, 1] as [number, number, number] })), index = createPhysicalSpatialIndex(bounds)
  for (const x of [-Number.EPSILON * 9, -Number.EPSILON * 8, -0, 0, 1, 1 + Number.EPSILON * 8]) for (const direction of [[0, 0, 0], [-0, 0, 1], [1, 0, 0], [1e-10, 0, 1], [9.999999999e-11, 0, 1]] as const) {
    const results = [visitPhysicalSpatialRay, priorVisit].map(visit => { const ids: number[] = []; visit(index, [x, 0, 0], direction, () => Infinity, id => ids.push(id)); return ids })
    expect(results[0]).toEqual(results[1])
  }
})

const comparePick = (entries: ReadonlyArray<PhysicalPickEntry>, point: { x: number; y: number }, width: number, height: number): boolean => {
  const actual = pickPhysicalMesh(entries, point, width, height), expected = priorPick(entries, point, width, height)
  expect(actual?.sceneId).toBe(expected?.sceneId); expect(actual?.mesh).toBe(expected?.mesh)
  expect(Object.is(actual?.depth, expected?.depth)).toBe(true)
  expect(actual?.position).toEqual(expected?.position)
  return actual !== null
}
const camera = (bounds: { min: Vector3; max: Vector3 }, bearing: number, pitch: number): Float64Array => {
  const center = bounds.min.map((value, axis) => (value + bounds.max[axis]!) / 2), span = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]!)), b = bearing * Math.PI / 180, p = pitch * Math.PI / 180
  const right: Vector3 = [Math.cos(b), Math.sin(b), 0], up: Vector3 = [-Math.sin(b) * Math.cos(p), Math.cos(b) * Math.cos(p), Math.sin(p)], back: Vector3 = [Math.sin(b) * Math.sin(p), -Math.cos(b) * Math.sin(p), Math.cos(p)]
  const matrix = new Float64Array(16)
  for (let axis = 0; axis < 3; axis++) { matrix[axis * 4] = right[axis]! / span * 2; matrix[axis * 4 + 1] = up[axis]! / span * 2; matrix[axis * 4 + 2] = -back[axis]! / span * 2 }
  for (let row = 0; row < 3; row++) matrix[12 + row] = -(matrix[row]! * center[0]! + matrix[4 + row]! * center[1]! + matrix[8 + row]! * center[2]!)
  matrix[15] = 1; return matrix
}

test('actual selected R5 floor/camera/opacity/offset cases retain exact source winners and world hit positions', async () => {
  const scenario = await compileScenarioDefinition(scenarioDefinitionSchema.parse(definitionSource), [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() }), seen = new Set<string>()
  let hits = 0
  for (const object of scenario.initialObjects) {
    const descriptor = describePhysicalLayoutScene(object, scenario.initialObjects)
    if (!descriptor?.geometryKey || seen.has(descriptor.geometryKey)) continue
    seen.add(descriptor.geometryKey)
    const scene = await loadPhysicalLayoutScene(object)
    for (const levelId of ['all', scene.levels[0]!.id]) {
      const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId, separation: levelId === 'all' ? 1 : 0, hiddenLayerIds: [] }, asset = preparePhysicalGeometry(scene, view, `${scene.id}/${levelId}`)
      const placed = levelId === 'all' ? asset.meshes.map(mesh => ({ ...mesh, offset: mesh.offset.map(value => value * 9) as unknown as Vector3 })) : asset.meshes
      for (const [bearing, pitch] of [[-25, 50], [140, 75]]) for (const alpha of [0, .4, 1]) {
        const matrix = camera(scene.bounds, bearing!, pitch!), boundary = visiblePhysicalInspectionBoundaries(placed, matrix), selected = visiblePhysicalSurfaceOwners(boundary.filter(mesh => physicalArchitectureOpacity(mesh.object, { wallOpacity: alpha, floorOpacity: alpha }) > 0)), pickable = selected.filter(mesh => mesh.object.subjectIds.length > 0 || physicalArchitectureOpacity(mesh.object, { wallOpacity: alpha, floorOpacity: alpha }) === 1)
        const entries = [{ sceneId: scene.id, matrix, meshes: pickable, roster: placed }], width = 1000, height = 700
        const points = Array.from({ length: 24 }, () => ({ x: random() * width, y: random() * height }))
        for (const mesh of pickable.filter(mesh => mesh.object.subjectIds.length > 0).slice(0, 24)) {
          const center = mesh.bounds.min.map((value, axis) => (value + mesh.bounds.max[axis]!) / 2 + mesh.offset[axis]!) as unknown as Vector3, point = transform(matrix, center)
          points.push({ x: (point[0] + 1) * width / 2, y: (1 - point[1]) * height / 2 })
        }
        for (const point of points) if (comparePick(entries, point, width, height)) hits++
      }
    }
  }
  expect(seen.size).toBe(2); expect(hits).toBeGreaterThan(100)
}, 60_000)
