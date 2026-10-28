import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import definitionSource from '../src/scenarios/halden-normal-operation.scenario.json'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../src/packs/physical-layout/scene.ts'
import { buildVisibleMeshes, meshBounds, type PhysicalMesh } from '../src/ui/map/physical-scene/geometry.ts'
import { physicalMeshDemandScene } from '../src/ui/map/physical-scene/layer-demand.ts'
import { clipPhysicalMeshesToScope } from '../src/ui/map/physical-scene/scope-clipping.ts'
import { physicalSurfaceAnnotations } from '../src/ui/map/physical-scene/surface-annotations.ts'
import { preparePhysicalSurfaceOwnership } from '../src/ui/map/physical-scene/surface-ownership.ts'
import { preparePhysicalPickAcceleration } from '../src/ui/map/physical-scene/picking.ts'
import { preparePhysicalRenderBuffers } from '../src/ui/map/physical-scene/render-buffers.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import { preparePhysicalSurfaceOwnership as priorOwnership } from './fixtures/physical-layout/surface-ownership-before-empty-fastpath.ts'
import { preparePhysicalSurfaceOwnership as beforeTwoLevel } from './fixtures/physical-layout/surface-ownership-before-two-level.ts'

type Ownership = ReturnType<typeof preparePhysicalSurfaceOwnership>
const fingerprint = (owned: Ownership): string => {
  const hash = createHash('sha256'), binary = (values: ArrayBufferView) => hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
  const meshes = owned.meshes.map((mesh, index) => ({ ...mesh, assetKey: 'same-exact-source', assetIndex: index }))
  for (const { object, vertices, lines, ...metadata } of meshes) { hash.update(JSON.stringify([object.id, metadata])); binary(Float64Array.from(vertices)); binary(Float64Array.from(lines)) }
  const buffers = preparePhysicalRenderBuffers(meshes); binary(buffers.vertices); binary(buffers.lines); hash.update(JSON.stringify([buffers.roles, buffers.objectCount]))
  const acceleration = preparePhysicalPickAcceleration(meshes)
  for (const index of [acceleration.meshes, ...acceleration.triangles.map(item => item.triangles)]) for (const values of [index.bounds, index.children, index.ranges, index.order]) binary(values)
  const { broadPhaseCandidates: _work, ...diagnostics } = owned.diagnostics
  hash.update(JSON.stringify(diagnostics)); return hash.digest('hex')
}
const compare = (meshes: ReadonlyArray<PhysicalMesh>, reference = priorOwnership): void => {
  const prior = reference(meshes), current = preparePhysicalSurfaceOwnership(meshes)
  // A conservative hierarchy may visit different false-positive leaves; its
  // exact candidates, ownership and all output/picking bytes must stay equal.
  const { broadPhaseCandidates: _beforeWork, ...before } = prior.diagnostics, { broadPhaseCandidates: _afterWork, ...after } = current.diagnostics
  expect(after).toEqual(before); expect(current.meshes.length).toBe(prior.meshes.length)
  for (let index = 0; index < current.meshes.length; index++) expect(current.meshes[index]!.object).toBe(prior.meshes[index]!.object)
  expect(fingerprint(current)).toBe(fingerprint(prior))
}
const mesh = (id: string, faces: ReadonlyArray<readonly [number, number, number]>, material = 0): PhysicalMesh => {
  const vertices = Float64Array.from(faces.flatMap(([x, y, z]) => [x, y, z, -0, 0, 1, material]))
  return { key: id, object: { id, label: id, kind: 'equipment', levelId: 'lower', subjectIds: [id], positions: [], materials: ['shell', 'service'] }, vertices, lines: new Float64Array([-0, 0, 0, 4, 0, 0]), lineMaterials: ['line'], lineStyles: ['feature'], levelId: 'lower', offset: [0, 0, 0], bounds: meshBounds(vertices) }
}

test('empty-candidate append preserves holes, material/normal/line bytes, degenerate omissions and mixed ownership group order', () => {
  const ring = mesh('ring', [[0, 0, 0], [4, 0, 0], [1, 1, 0], [4, 0, 0], [3, 1, 0], [1, 1, 0], [4, 0, 0], [4, 4, 0], [3, 1, 0], [4, 4, 0], [3, 3, 0], [3, 1, 0], [4, 4, 0], [0, 4, 0], [3, 3, 0], [0, 4, 0], [1, 3, 0], [3, 3, 0], [0, 4, 0], [0, 0, 0], [1, 3, 0], [0, 0, 0], [1, 1, 0], [1, 3, 0]], 1)
  const cover = mesh('cover', [[-1, -1, 0], [2, -1, 0], [2, 5, 0], [-1, -1, 0], [2, 5, 0], [-1, 5, 0]])
  const separate = mesh('no-overlap', [[8, 0, 2], [9, 0, 2], [8, 1, 2]], 1), degenerate = mesh('degenerate', [[0, 0, 0], [1, 0, 0], [2, 0, 0]])
  for (const inputs of [[ring], [separate, ring, degenerate], [cover, ring, separate, degenerate], [ring, cover, separate], [{ ...cover, inspectionPart: 'full' as const }, { ...cover, key: 'cover-cut', inspectionPart: 'cut' as const }, ring]]) compare(inputs)
  const result = preparePhysicalSurfaceOwnership([degenerate]); expect(result.meshes[0]!.vertices.length).toBe(0); expect(result.meshes[0]!.lines).toBe(degenerate.lines)
})

test('actual admitted R5 all-layer unit and campus retain exact ordered geometry, ownership, render buffers and picking arrays', async () => {
  const scenario = await compileScenarioDefinition(scenarioDefinitionSchema.parse(definitionSource), [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() }), seen = new Set<string>()
  for (const object of scenario.initialObjects) {
    const descriptor = describePhysicalLayoutScene(object, scenario.initialObjects)
    if (!descriptor?.geometryKey || seen.has(descriptor.geometryKey)) continue
    seen.add(descriptor.geometryKey)
    const scene = await loadPhysicalLayoutScene(object), view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'all', hiddenLayerIds: [] }, demand = physicalMeshDemandScene(scene, view)
    compare(physicalSurfaceAnnotations(demand, view, clipPhysicalMeshesToScope(demand, view, buildVisibleMeshes(demand, view))), beforeTwoLevel)
  }
  expect(seen.size).toBe(2)
}, 30_000)
