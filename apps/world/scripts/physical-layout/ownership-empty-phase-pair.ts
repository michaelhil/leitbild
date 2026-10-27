import { createHash } from 'node:crypto'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import definitionSource from '../../src/scenarios/halden-normal-operation.scenario.json'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../../src/packs/physical-layout/scene.ts'
import { buildVisibleMeshes } from '../../src/ui/map/physical-scene/geometry.ts'
import { physicalMeshDemandScene } from '../../src/ui/map/physical-scene/layer-demand.ts'
import { clipPhysicalMeshesToScope } from '../../src/ui/map/physical-scene/scope-clipping.ts'
import { physicalSurfaceAnnotations } from '../../src/ui/map/physical-scene/surface-annotations.ts'
import { preparePhysicalSurfaceOwnership } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { preparePhysicalSurfaceOwnership as priorOwnership } from '../../tests/fixtures/physical-layout/surface-ownership-before-empty-fastpath.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'

const output = process.env.LEITBILD_OWNERSHIP_PHASE_RECEIPT, quietInterval = process.env.LEITBILD_OWNERSHIP_PHASE_QUIET
if (!output || !quietInterval) throw Error('Set LEITBILD_OWNERSHIP_PHASE_RECEIPT and describe the coordinated idle CPU interval in LEITBILD_OWNERSHIP_PHASE_QUIET')
const fingerprint = (owned: ReturnType<typeof preparePhysicalSurfaceOwnership>): string => {
  const hash = createHash('sha256')
  for (const { object, vertices, lines, ...metadata } of owned.meshes) {
    hash.update(JSON.stringify([object.id, metadata]))
    for (const values of [vertices, lines]) { const typed = values instanceof Float64Array ? values : Float64Array.from(values); hash.update(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)) }
  }
  hash.update(JSON.stringify(owned.diagnostics)); return hash.digest('hex')
}
const scenario = await compileScenarioDefinition(scenarioDefinitionSchema.parse(definitionSource), [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() }), seen = new Set<string>(), rows = []
for (const object of scenario.initialObjects) {
  const descriptor = describePhysicalLayoutScene(object, scenario.initialObjects)
  if (!descriptor?.geometryKey || seen.has(descriptor.geometryKey)) continue
  seen.add(descriptor.geometryKey)
  const scene = await loadPhysicalLayoutScene(object), view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'all', hiddenLayerIds: [] }, demand = physicalMeshDemandScene(scene, view)
  const meshes = physicalSurfaceAnnotations(demand, view, clipPhysicalMeshesToScope(demand, view, buildVisibleMeshes(demand, view))), samples = []
  let expected: string | undefined
  for (const [pair, order] of [['AB', ['baseline', 'candidate']], ['BA', ['candidate', 'baseline']]] as const) for (const kind of order) {
    Bun.gc(true)
    const start = performance.now(), owned = (kind === 'baseline' ? priorOwnership : preparePhysicalSurfaceOwnership)(meshes), ms = performance.now() - start
    const sha256 = fingerprint(owned)
    if (expected !== undefined && sha256 !== expected) throw Error(`Ownership bytes changed for ${scene.id}/${pair}/${kind}`)
    expected = sha256; samples.push({ pair, kind, ms, sha256 })
  }
  rows.push({ sceneId: scene.id, design: scene.revision, allDeclaredLayers: true, triangles: meshes.reduce((sum, mesh) => sum + mesh.vertices.length / 21, 0), samples })
}
const sourceFiles = ['../../src/ui/map/physical-scene/surface-ownership.ts', '../../tests/fixtures/physical-layout/surface-ownership-before-empty-fastpath.ts']
const receipt = { commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(), quietInterval, sourceHashes: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await Bun.file(new URL(file, import.meta.url)).text()).digest('hex')]))), note: 'Two serial AB/BA pairs per admitted R5 family, identical all-layer input. GC outside timed ownership regions; output hashing outside timing. This isolates one CPU phase, not cold browser loading, whole preparation, statistical confidence or frame performance.', rows }
await Bun.write(output, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2))
