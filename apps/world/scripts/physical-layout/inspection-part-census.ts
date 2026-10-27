import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
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
import type { preparePhysicalSurfaceOwnership } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'

/** Test-only attribution over the actual algorithm. Count impossible pairs at
 * successive existing predicates without skipping them or changing output. */
const output = process.env.LEITBILD_INSPECTION_CENSUS_RECEIPT
if (!output) throw Error('Set LEITBILD_INSPECTION_CENSUS_RECEIPT to retain this attribution receipt')
const path = resolve(import.meta.dir, '../../src/ui/map/physical-scene/surface-ownership.ts'), original = await Bun.file(path).text()
const replaceOnce = (source: string, needle: string, replacement: string): string => {
  if (source.split(needle).length !== 2) throw Error(`Diagnostic marker is not unique: ${needle}`)
  return source.replace(needle, replacement)
}
let instrumented = replaceOnce(original, 'type Vertex =', 'export let inspectionPartCounters = { earlier: 0, spatial: 0, coplanar: 0, overlappingApplications: 0 }\ntype Vertex =')
instrumented = replaceOnce(instrumented, '  const cohorts =', '  inspectionPartCounters = { earlier: 0, spatial: 0, coplanar: 0, overlappingApplications: 0 }\n  const cohorts =')
instrumented = replaceOnce(instrumented, '        const cover = faces[candidate]!\n        //', `        const cover = faces[candidate]!
        const firstMesh = meshes[cover.mesh]!, laterMesh = meshes[face.mesh]!
        const exclusive = firstMesh.inspectionPart !== undefined && laterMesh.inspectionPart !== undefined && firstMesh.inspectionPart !== laterMesh.inspectionPart && firstMesh.object.id === laterMesh.object.id
        if (exclusive) inspectionPartCounters.earlier++
        //`)
instrumented = replaceOnce(instrumented, '        if (!onPlane(', '        if (exclusive) inspectionPartCounters.spatial++\n        if (!onPlane(')
instrumented = replaceOnce(instrumented, '        candidates.push(candidate)', '        if (exclusive) inspectionPartCounters.coplanar++\n        candidates.push(candidate)')
instrumented = replaceOnce(instrumented, '          if (result.overlap > 0) {', `          if (result.overlap > 0) {
            const firstMesh = meshes[cover.mesh]!, laterMesh = meshes[face.mesh]!
            if (firstMesh.inspectionPart !== undefined && laterMesh.inspectionPart !== undefined && firstMesh.inspectionPart !== laterMesh.inspectionPart && firstMesh.object.id === laterMesh.object.id) inspectionPartCounters.overlappingApplications++`)
instrumented = instrumented.replace(/from '(\.[^']+)'/g, (_match, relative: string) => `from '${pathToFileURL(resolve(dirname(path), relative)).href}'`)
const temp = await mkdtemp(join(tmpdir(), 'leitbild-inspection-part-census-'))
try {
  const modulePath = join(temp, 'instrumented.ts'); await Bun.write(modulePath, instrumented)
  const probe = await import(modulePath) as { readonly preparePhysicalSurfaceOwnership: typeof preparePhysicalSurfaceOwnership; readonly inspectionPartCounters: { readonly earlier: number; readonly spatial: number; readonly coplanar: number; readonly overlappingApplications: number } }
  const definition = scenarioDefinitionSchema.parse(await Bun.file(resolve(import.meta.dir, '../../src/scenarios/halden-normal-operation.scenario.json')).json())
  const scenario = await compileScenarioDefinition(definition, [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() }), seen = new Set<string>(), rows = []
  for (const object of scenario.initialObjects) {
    const descriptor = describePhysicalLayoutScene(object, scenario.initialObjects)
    if (!descriptor?.geometryKey || seen.has(descriptor.geometryKey)) continue
    seen.add(descriptor.geometryKey)
    const scene = await loadPhysicalLayoutScene(object), view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId: 'all', hiddenLayerIds: [] }, demand = physicalMeshDemandScene(scene, view)
    const meshes = physicalSurfaceAnnotations(demand, view, clipPhysicalMeshesToScope(demand, view, buildVisibleMeshes(demand, view)))
    const owned = probe.preparePhysicalSurfaceOwnership(meshes)
    rows.push({ sceneId: scene.id, design: scene.revision, meshes: meshes.length, triangles: meshes.reduce((sum, mesh) => sum + mesh.vertices.length / 21, 0), counters: { ...probe.inspectionPartCounters }, diagnostics: { ...owned.diagnostics, coincidentPairs: owned.diagnostics.coincidentPairs.length }, outputFragments: owned.meshes.length })
  }
  const receipt = { note: 'Diagnostic count only. The exact baseline predicate/partition path still processes all pairs; no skip or geometry change. These counts do not establish saved time or visual equivalence of a proposed exclusion.', commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(), ownershipSourceSha256: createHash('sha256').update(original).digest('hex'), rows }
  await Bun.write(output, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2))
} finally { await rm(temp, { recursive: true, force: true }) }
