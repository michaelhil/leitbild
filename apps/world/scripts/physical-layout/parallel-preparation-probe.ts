import { createHash } from 'node:crypto'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { compileRetainedPhysicalSource } from '../../src/packs/physical-layout/source-compile.ts'
import { createPhysicalPreparationPool, physicalPreparedGeometryBytes, type PhysicalPreparedGeometry } from '../../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'

const fingerprint = (asset: PhysicalPreparedGeometry): string => {
  const hash = createHash('sha256'), binary = (values: ArrayLike<number>) => hash.update(new Uint8Array(Float64Array.from(values).buffer))
  for (const mesh of asset.meshes) {
    hash.update(JSON.stringify([mesh.key,mesh.assetIndex,mesh.levelId,mesh.planPriority,mesh.offset,mesh.bounds,mesh.occludedBy,mesh.lineMaterials,mesh.lineStyles,mesh.object.id,mesh.object.subjectIds,mesh.object.material,mesh.object.materials,mesh.object.scopeIds,mesh.object.layerId]))
    binary(mesh.vertices); binary(mesh.lines)
  }
  for (const index of [asset.acceleration.meshes,...asset.acceleration.triangles.map(item => item.triangles)]) for (const values of [index.bounds,index.children,index.ranges,index.order]) binary(values)
  binary(asset.buffers.vertices); binary(asset.buffers.lines); hash.update(JSON.stringify([asset.buffers.roles,asset.surfaceOwnership])); return hash.digest('hex')
}
const definition = scenarioDefinitionSchema.parse(await Bun.file(new URL('../../src/scenarios/halden-normal-operation.scenario.json',import.meta.url)).json())
const scenario = await compileScenarioDefinition(definition,[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()})
const layouts = scenario.initialObjects.filter(object => object.packId === 'physical-layout' && ['layout:halden-1','layout:halden-campus'].includes(object.id))
if (layouts.length !== 2) throw Error('The parallel probe requires the frozen unit and campus fixtures')
const scenes = await Promise.all(layouts.map(object => compileRetainedPhysicalSource(object.packData)))
const records: Array<{kind:string;ms:number;workerCountCreated:number;before:unknown;ready:unknown;closed:unknown;assets:Array<{key:string;ms:number;sha256:string;cpuBytes:number}>}> = []
const reported = navigator.hardwareConcurrency
for (const [kind,cpus] of [['serial',1],['reported',reported]] as const) {
  let workerCountCreated = 0
  const pool = createPhysicalPreparationPool(() => { workerCountCreated++; return new Worker(new URL('../../src/ui/map/physical-scene/preparation-worker.ts',import.meta.url),{type:'module'}) },() => cpus)
  const owner = pool.createPreparer(); owner.retainIdentities!(new Set(scenes.map(scene => scene.revision)))
  Bun.gc(true)
  const start = performance.now(), tasks = scenes.map(async scene => {
    const asset = await owner(scene,{...defaultPhysicalSceneView(scene.levels),mode:'3d',levelId:'all'},`${scene.revision}/all`,scene.revision,`${scene.revision}/detail`)
    return {asset,ms:performance.now()-start}
  }), before = pool.diagnostics()
  try {
    const results = await Promise.all(tasks), ms = performance.now()-start, ready = pool.diagnostics()
    const assets = results.map(({asset,ms}) => ({key:asset.key,ms,sha256:fingerprint(asset),cpuBytes:physicalPreparedGeometryBytes(asset)}))
    owner.destroy!(); const closed = pool.diagnostics()
    if (closed.workerCount || closed.registeredBytes || closed.inFlightJobs || closed.queuedViews || closed.pinnedSources) throw Error('Parallel preparation leaked owned resources')
    records.push({kind,ms,workerCountCreated,before,ready,closed,assets})
  } finally { owner.destroy!() }
}
const outputEqual = records[0]!.assets.every((asset,index) => asset.sha256 === records[1]!.assets[index]!.sha256)
console.log(JSON.stringify({at:new Date().toISOString(),bun:Bun.version,reportedLogicalCpus:reported,records,outputEqual,limits:['Real Bun module workers and exact admitted r2 Halden sources; source compilation is outside the worker-pool timing.','Serial then reported-capacity runs on one device; not a browser, network, GPU upload or product benchmark.','Typed storage metrics exclude module heaps, process overhead and temporary allocations; report worker count alongside bytes.']},null,2))
if (!outputEqual) process.exitCode=1
