import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../../src/packs/physical-layout/scene.ts'
import { buildVisibleMeshes } from '../../src/ui/map/physical-scene/geometry.ts'
import { clipPhysicalMeshesToScope } from '../../src/ui/map/physical-scene/scope-clipping.ts'
import { physicalSurfaceAnnotations } from '../../src/ui/map/physical-scene/surface-annotations.ts'
import { preparePhysicalSurfaceOwnership } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { preparePhysicalPickAcceleration } from '../../src/ui/map/physical-scene/picking.ts'
import { preparePhysicalRenderBuffers } from '../../src/ui/map/physical-scene/render-buffers.ts'
import type { PhysicalPreparationView } from '../../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'

const sourceHashes = Object.fromEntries(await Promise.all(['geometry', 'scope-clipping', 'surface-annotations', 'surface-ownership', 'spatial-index', 'picking', 'render-buffers'].map(async name => [name, createHash('sha256').update(await Bun.file(join(import.meta.dir, '../../src/ui/map/physical-scene/' + name + '.ts')).text()).digest('hex')])))
const output = process.env.LEITBILD_PREPARATION_PROFILE_DIR
if (!output) throw Error('Set LEITBILD_PREPARATION_PROFILE_DIR to retain diagnostic stage timings and exact geometry hashes')
await mkdir(output, { recursive: true })
const definition = scenarioDefinitionSchema.parse(await Bun.file(join(import.meta.dir, '../../src/scenarios/halden-normal-operation.scenario.json')).json())
const scenario = await compileScenarioDefinition(definition, [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
const families = new Set<string>(), profiles = []
for (const object of scenario.initialObjects) {
  const descriptor = describePhysicalLayoutScene(object, scenario.initialObjects)
  if (!descriptor) continue
  const family = descriptor.geometryKey
  if (!family) throw Error('The admitted profile has no geometry identity')
  if (families.has(family)) continue
  families.add(family)
  const scene = await loadPhysicalLayoutScene(object), levelId = process.env.LEITBILD_PREPARATION_PROFILE_LEVEL ?? 'all'
  const familyFilter = process.env.LEITBILD_PREPARATION_PROFILE_FAMILY
  if (familyFilter && !(familyFilter === 'unit' ? scene.id === 'layout:halden-1' : familyFilter === 'campus' ? scene.id === 'layout:halden-campus' : false)) continue
  if (levelId !== 'all' && !scene.levels.some(level => level.id === levelId)) continue
  const base = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, levelId }, cases: PhysicalPreparationView[] = process.env.LEITBILD_PREPARATION_PROFILE_MATRIX ? [
    { ...base, levelId: 'all' }, ...scene.levels.map(level => ({ ...base, levelId: level.id })),
    { ...base, levelId: 'all', cutaway: false }, { ...base, levelId: 'all', separation: 1 },
    ...scene.levels.filter(level => level.id === 'lower' || level.id === 'operating' || scene.id === 'layout:halden-campus').map(level => ({ ...base, mode: '2d' as const, levelId: level.id })),
    ...(scene.scopes?.some(scope => scope.id === 'area/turbine-island') ? ['all', 'lower', 'operating'].map(levelId => ({ ...base, levelId, scopeId: 'area/turbine-island' })) : []),
  ] : [base]
  for (const view of cases) {
  const caseId = JSON.stringify([view.mode, view.levelId, view.cutaway, view.separation, view.scopeId ?? null]), timings: Record<string, number> = {}
  let last = performance.now()
  const stamp = (name: string) => { const now = performance.now(); timings[name] = now - last; last = now }
  let meshes = buildVisibleMeshes(scene, view); stamp('build')
  meshes = [...clipPhysicalMeshesToScope(scene, view, meshes)]; stamp('clip')
  meshes = [...physicalSurfaceAnnotations(scene, view, meshes)]; stamp('annotations')
  const owned = preparePhysicalSurfaceOwnership(meshes); meshes = [...owned.meshes]; stamp('ownership')
  const acceleration = preparePhysicalPickAcceleration(meshes); stamp('picking')
  const buffers = preparePhysicalRenderBuffers(meshes); stamp('buffers')
  const hash = createHash('sha256'), bytes = (value: ArrayBufferView) => hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  for (const mesh of meshes) {
    hash.update(JSON.stringify({ key: mesh.key, occurrence: mesh.object.id, offset: mesh.offset, bounds: mesh.bounds, materials: mesh.materials, lineMaterials: mesh.lineMaterials, lineStyles: mesh.lineStyles, occludedBy: mesh.occludedBy, annotation: mesh.annotation, inspectionPart: mesh.inspectionPart, inspectionScopeId: mesh.inspectionScopeId, levelId: mesh.levelId, planPriority: mesh.planPriority }))
    bytes(Float64Array.from(mesh.vertices)); bytes(Float64Array.from(mesh.lines))
  }
  bytes(buffers.vertices); bytes(buffers.lines)
  hash.update(JSON.stringify({ roles: buffers.roles, objectCount: buffers.objectCount }))
  const exactGeometrySha256 = hash.copy().digest('hex')
  for (const index of [acceleration.meshes, ...acceleration.triangles.map(item => item.triangles)]) { bytes(index.bounds); bytes(index.children); bytes(index.ranges); bytes(index.order) }
  const profile = { sceneId: scene.id, design: scene.revision, levelId: view.levelId, caseId, objects: scene.objects.length, meshes: meshes.length, timings, totalMs: Object.values(timings).reduce((sum, value) => sum + value, 0), exactGeometrySha256, exactGeometryAndPickingSha256: hash.digest('hex'), ownership: owned.diagnostics, note: 'CPU stage attribution only; no browser cold-load or interaction performance claim. Exact hash covers ordered geometry, materials, conditional ownership and picking arrays.' }
  profiles.push(profile)
  }
}
const result = { sourceHashes, commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(), dirty: Bun.spawnSync(['git', 'status', '--porcelain']).stdout.toString(), profiles }
const baselinePath = process.env.LEITBILD_PREPARATION_BASELINE_RECEIPT
if (baselinePath) {
  const baseline = await Bun.file(baselinePath).json() as typeof result
  for (const profile of profiles) {
    const prior = baseline.profiles.find(row => row.design === profile.design && row.levelId === profile.levelId && (!row.caseId || row.caseId === profile.caseId))
    if (!prior || prior.exactGeometryAndPickingSha256 !== profile.exactGeometryAndPickingSha256) throw Error('Preparation changed exact geometry or picking arrays: ' + profile.design + '/' + profile.levelId)
  }
}
await writeFile(join(output, 'receipt.json'), JSON.stringify({ ...result, ...(baselinePath ? { exactBaselineVerified: baselinePath } : {}) }, null, 2))
console.log(JSON.stringify({ output, profiles: profiles.map(({ ownership, ...profile }) => ({ ...profile, ownership: { ...ownership, coincidentPairs: ownership.coincidentPairs.length } })) }, null, 2))
