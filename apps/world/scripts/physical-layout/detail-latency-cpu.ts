// Test-only phase census of the exact retained local fixture, not a product latency verdict.
import { physicalLayoutDataSchema, type RetainedPhysicalLayoutData } from '../../src/packs/physical-layout/model.ts'
import { validateRetainedPhysicalSource } from '../../src/packs/physical-layout/source-validation.ts'
import { compileRetainedPhysicalSource } from '../../src/packs/physical-layout/source-compile.ts'
import { buildVisibleMeshes } from '../../src/ui/map/physical-scene/geometry.ts'
import { physicalMeshDemandScene } from '../../src/ui/map/physical-scene/layer-demand.ts'
import { physicalSurfaceAnnotations } from '../../src/ui/map/physical-scene/surface-annotations.ts'
import { clipPhysicalMeshesToScope } from '../../src/ui/map/physical-scene/scope-clipping.ts'
import { preparePhysicalSurfaceOwnership } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { preparePhysicalPickAcceleration } from '../../src/ui/map/physical-scene/picking.ts'
import { preparePhysicalRenderBuffers } from '../../src/ui/map/physical-scene/render-buffers.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'
import type { PhysicalPreparationView } from '../../src/ui/map/physical-scene/preparation.ts'
import { physicalLayoutViewDefaults } from '../../src/packs/physical-layout/view-defaults.ts'

const input = process.argv[2], output = process.argv[3]
if (!input || !output) throw Error('Expected retained local compiled-scenario.json and output receipt')
const scenario = await Bun.file(input).json() as { initialObjects: ReadonlyArray<{ id: string; packId: string; packData: unknown }> }
const records: unknown[] = [], instances: RetainedPhysicalLayoutData[] = []
for (const object of scenario.initialObjects.filter(object => object.packId === 'physical-layout')) {
  const started = performance.now(), data = physicalLayoutDataSchema.parse(object.packData), parsedAt = performance.now()
  await validateRetainedPhysicalSource(data)
  records.push({ phase: 'per-instance-source-boundary', id: object.id, design: data.design.digest, parseMs: parsedAt - started, validateMs: performance.now() - parsedAt })
  instances.push(data)
}
for (const data of new Map(instances.map(data => [data.design.digest, data])).values()) {
  const started = performance.now(), scene = await compileRetainedPhysicalSource(data)
  records.push({ phase: 'family-compile-including-validation', design: data.design.digest, ms: performance.now() - started, objects: scene.objects.length })
  const layers = scene.layers ?? [], visible = new Set(physicalLayoutViewDefaults(data.source, 'presentation' in data ? data.presentation.layers : undefined).visibleLayerIds)
  const base: PhysicalPreparationView = { ...defaultPhysicalSceneView(scene.levels), mode: '3d', levelId: 'all', cutaway: true, hiddenLayerIds: layers.filter(layer => !layer.defaultVisible && !visible.has(layer.id)).map(layer => layer.id) }
  const hall = scene.scopes?.find(scope => scope.label === 'Turbine hall and feedwater pump annex')
  const views: PhysicalPreparationView[] = [base, { ...base, levelId: scene.levels.some(level => level.id === 'operating') ? 'operating' : scene.levels[0]!.id }, ...(hall ? [{ ...base, scopeId: hall.id }] : [])]
  for (const view of views) {
    const phases: Record<string, number> = {}, measure = <T>(name: string, work: () => T): T => { const at = performance.now(), result = work(); phases[name] = performance.now() - at; return result }
    const demand = measure('layer-selection', () => physicalMeshDemandScene(scene, view))
    const meshes = measure('meshing-and-floor-cut', () => buildVisibleMeshes(demand, view))
    const clipped = measure('scope-clip', () => clipPhysicalMeshesToScope(demand, view, meshes))
    const decorated = measure('surface-annotations', () => physicalSurfaceAnnotations(demand, view, clipped))
    const owned = measure('surface-ownership', () => preparePhysicalSurfaceOwnership(decorated))
    const acceleration = measure('picking-index', () => preparePhysicalPickAcceleration(owned.meshes))
    const buffers = measure('render-packing', () => preparePhysicalRenderBuffers(owned.meshes))
    records.push({ phase: 'view-preparation', design: data.design.digest, view, phases, totalMs: Object.values(phases).reduce((a, b) => a + b, 0), sourceMeshes: meshes.length, scopedMeshes: clipped.length, ownedMeshes: owned.meshes.length, triangles: buffers.vertices.length / 8 / 3, lineSegments: buffers.lines.length / 6 / 2, renderBytes: buffers.vertices.byteLength + buffers.lines.byteLength, pickMeshNodes: acceleration.meshes.children.length / 2, ownership: { ...owned.diagnostics, coincidentPairs: owned.diagnostics.coincidentPairs.length } })
  }
}
await Bun.write(output, JSON.stringify({ at: new Date().toISOString(), bun: Bun.version, input, records, limits: ['Exact retained R5 inputs and unchanged production functions, sequential phase census after module loading. Not a browser/network/worker/GPU latency measurement.', 'Compilation follows the per-instance validation census, so its caches/JIT may be warm. No speedup is claimed from these absolute timings.', 'View functions execute in the same production order. Outputs are not retained as an additional product cache.'] }, null, 2))
