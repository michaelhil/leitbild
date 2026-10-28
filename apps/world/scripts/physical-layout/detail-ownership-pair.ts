// Test-only AB/BA comparison: both engines receive the same immutable meshes.
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { physicalLayoutDataSchema } from '../../src/packs/physical-layout/model.ts'
import { compileRetainedPhysicalSource } from '../../src/packs/physical-layout/source-compile.ts'
import { buildVisibleMeshes, type PhysicalMesh } from '../../src/ui/map/physical-scene/geometry.ts'
import { physicalMeshDemandScene } from '../../src/ui/map/physical-scene/layer-demand.ts'
import { physicalSurfaceAnnotations } from '../../src/ui/map/physical-scene/surface-annotations.ts'
import { clipPhysicalMeshesToScope } from '../../src/ui/map/physical-scene/scope-clipping.ts'
import { preparePhysicalSurfaceOwnership as current } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { preparePhysicalSurfaceOwnership as before } from '../../tests/fixtures/physical-layout/surface-ownership-before-two-level.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'

const input = process.argv[2], output = process.argv[3]
if (!input || !output) throw Error('Expected retained local compiled-scenario.json and output receipt')
const indexOnly: typeof current | undefined = process.argv[4] ? (await import(resolve(process.argv[4]))).preparePhysicalSurfaceOwnership : undefined
const scenario = await Bun.file(input).json() as { initialObjects: ReadonlyArray<{ packId: string; packData: unknown }> }
const unique = new Map(scenario.initialObjects.filter(object => object.packId === 'physical-layout').map(object => {
  const data = physicalLayoutDataSchema.parse(object.packData); return [data.design.digest, data] as const
}))
const fingerprint = (owned: ReturnType<typeof current>): string => {
  const hash = createHash('sha256')
  for (const { vertices, lines, object, ...metadata } of owned.meshes) {
    hash.update(JSON.stringify([object.id, metadata]))
    for (const values of [vertices, lines]) hash.update(new Uint8Array(Float64Array.from(values).buffer))
  }
  const { broadPhaseCandidates: _work, ...exact } = owned.diagnostics
  hash.update(JSON.stringify(exact)); return hash.digest('hex')
}
const prepared: Array<{ design: string; meshes: ReadonlyArray<PhysicalMesh> }> = []
for (const [design, data] of unique) {
  if (process.env.LEITBILD_OWNERSHIP_DESIGN_PREFIX && !design.startsWith(process.env.LEITBILD_OWNERSHIP_DESIGN_PREFIX)) continue
  const scene = await compileRetainedPhysicalSource(data)
  const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'all', cutaway: true, hiddenLayerIds: [] }
  const demand = physicalMeshDemandScene(scene, view)
  prepared.push({ design, meshes: physicalSurfaceAnnotations(demand, view, clipPhysicalMeshesToScope(demand, view, buildVisibleMeshes(demand, view))) })
}
const records: Array<Record<string, unknown>> = []
for (const { design, meshes } of prepared) {
  let expected: string | undefined
  const run = (engine: 'before' | 'current' | 'index-only', phase: 'calibration' | 'paired', ordinal: number) => {
    const work = engine === 'before' ? before : engine === 'current' ? current : indexOnly!
    // Reclaim the preceding *test-only fingerprint* temporaries before each
    // engine call. This is not a product cache/GC policy or loading claim.
    Bun.gc(true)
    const memoryBefore = process.memoryUsage(), cpuBefore = process.cpuUsage(), at = performance.now(), result = work(meshes), ms = performance.now() - at, cpu = process.cpuUsage(cpuBefore), memoryAfter = process.memoryUsage(), resourceUsage = process.resourceUsage()
    // Verification deliberately occurs outside the timed ownership call.
    const digest = fingerprint(result)
    expected ??= digest
    if (digest !== expected) throw Error(`Ownership output mismatch: ${design}/${engine}/${ordinal}`)
    records.push({ design, engine, phase, ordinal, ms, cpu, memoryBefore, memoryAfter, resourceUsage, inputMeshes: meshes.length, inputTriangles: meshes.reduce((sum, mesh) => sum + mesh.vertices.length / 21, 0), outputMeshes: result.meshes.length, outputBytes: result.meshes.reduce((sum, mesh) => sum + (mesh.vertices.length + mesh.lines.length) * 8, 0), digest, diagnostics: { ...result.diagnostics, coincidentPairs: result.diagnostics.coincidentPairs.length } })
  }
  if (process.env.LEITBILD_OWNERSHIP_ENGINE) {
    const engine = process.env.LEITBILD_OWNERSHIP_ENGINE
    if (engine !== 'before' && engine !== 'current' && engine !== 'index-only') throw Error('Unknown ownership engine')
    if (engine === 'index-only' && !indexOnly) throw Error('Index-only engine requires its explicit module')
    run(engine, 'paired', 0)
  }
  else if (process.env.LEITBILD_OWNERSHIP_PROFILE_ONLY === '1') { run('before', 'paired', 0); run('current', 'paired', 1) }
  else {
    run('before', 'calibration', 0); run('current', 'calibration', 1)
    if (indexOnly) run('index-only', 'calibration', 2)
    const engines = indexOnly ? ['before', 'index-only', 'current', 'current', 'index-only', 'before'] as const : ['before', 'current', 'current', 'before'] as const
    for (const [ordinal, engine] of engines.entries()) run(engine, 'paired', ordinal)
  }
}
await Bun.write(output, JSON.stringify({ at: new Date().toISOString(), bun: Bun.version, input, indexOnlyModule: process.argv[4] ?? null, records, limits: ['Bun ownership-engine comparison, not browser/network/worker/GPU latency.', 'All source compilation, mesh construction and exact output hashing are outside each timed ownership call. Explicit test GC before each timed call reclaims prior fingerprint temporaries.', 'Memory snapshots are process RSS/heap snapshots, not a measured peak or total derived-asset residency.', 'Calibration is retained separately; the paired sequence reverses order. Actual prepared mesh inputs are shared, immutable and all-layer/all-level.'] }, null, 2))
