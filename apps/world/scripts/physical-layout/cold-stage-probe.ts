import { createHash } from 'node:crypto'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { processPlantPack } from '../../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../../src/packs/physical-layout/pack.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { physicalLayoutDataSchema } from '../../src/packs/physical-layout/model.ts'
import { validateRetainedPhysicalSource } from '../../src/packs/physical-layout/source-validation.ts'
import { compileRetainedPhysicalSource } from '../../src/packs/physical-layout/source-compile.ts'
import { copyPhysicalSceneForTransfer } from '../../src/core/packs/scene-transfer.ts'
import { packPhysicalSceneSchema } from '../../src/core/packs/scene.ts'
import { buildVisibleMeshes } from '../../src/ui/map/physical-scene/geometry.ts'
import { preparePhysicalSurfaceOwnership } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { preparePhysicalPickAcceleration, admitPhysicalPickAcceleration } from '../../src/ui/map/physical-scene/picking.ts'
import { preparePhysicalRenderBuffers } from '../../src/ui/map/physical-scene/render-buffers.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'

const timed = <T>(run: () => T): { value: T; ms: number } => { const start = performance.now(); const value = run(); return { value, ms: performance.now()-start } }
const timedAsync = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => { const start = performance.now(); const value = await run(); return { value, ms: performance.now()-start } }
const definition = scenarioDefinitionSchema.parse(await Bun.file(new URL('../../src/scenarios/halden-normal-operation.scenario.json',import.meta.url)).json())
const setup = await timedAsync(() => compileScenarioDefinition(definition,[processPlantPack,electricGridPack,weatherPack,physicalLayoutPack],{routing:createDirectRoutingAdapter()}))
const objects = setup.value.initialObjects.filter(object => object.packId === 'physical-layout' && ['layout:halden-1','layout:halden-campus'].includes(object.id))
if (objects.length !== 2) throw Error('The retained stage probe requires the frozen unit and campus layouts')
const records: unknown[] = []
for (const object of objects) {
  const parsed = timed(() => physicalLayoutDataSchema.parse(object.packData)), data = parsed.value
  const validated = await timedAsync(() => validateRetainedPhysicalSource(data))
  const compiled = await timedAsync(() => compileRetainedPhysicalSource(data)), scene = compiled.value
  const delivery = timed(() => copyPhysicalSceneForTransfer(scene))
  const admission = timed(() => packPhysicalSceneSchema.parse(delivery.value.scene))
  const views = object.id === 'layout:halden-1' ? [{levelId:'all'},{levelId:'operating'},{levelId:'all',cutaway:false},{levelId:'operating',mode:'2d' as const}] : [{levelId:'all'}]
  const variants: unknown[] = []
  for (const variant of views) {
    Bun.gc(true)
    const view = {...defaultPhysicalSceneView(scene.levels),mode:'3d' as const,...variant}
    const meshes = timed(() => buildVisibleMeshes(scene,view))
    const owned = timed(() => preparePhysicalSurfaceOwnership(meshes.value))
    const acceleration = timed(() => preparePhysicalPickAcceleration(owned.value.meshes))
    const buffers = timed(() => preparePhysicalRenderBuffers(owned.value.meshes))
    const admitted = timed(() => admitPhysicalPickAcceleration(owned.value.meshes,acceleration.value))
    variants.push({view,visibleMs:meshes.ms,ownershipMs:owned.ms,pickIndexMs:acceleration.ms,renderBufferMs:buffers.ms,pickAdmissionMs:admitted.ms,triangles:buffers.value.vertices.length/24,fragments:owned.value.meshes.length,broadPhaseCandidates:owned.value.diagnostics.broadPhaseCandidates,coplanarCandidates:owned.value.diagnostics.coplanarCandidates,renderBytes:buffers.value.vertices.byteLength+buffers.value.lines.byteLength})
  }
  records.push({id:object.id,design:data.design.digest,sourceDigest:data.sourceDigest,parseMs:parsed.ms,validationMs:validated.ms,compileWithValidationAndShapeCheckMs:compiled.ms,transferCopyMs:delivery.ms,transferBytes:delivery.value.transfers.reduce((sum,buffer)=>sum+buffer.byteLength,0),workerSceneAdmissionMs:admission.ms,variants})
}
console.log(JSON.stringify({at:new Date().toISOString(),bun:Bun.version,fixtureDefinitionSha256:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),fixtureSetupMs:setup.ms,records,limits:['Pure CPU stage attribution on the frozen admitted Halden fixture; no production Run mutation.','Explicit schema/validation attribution repeats that work separately; do not sum it with the inclusive compilation stage.','No network, actual worker queue/transport, GPU upload or painted-frame timing is claimed.']},null,2))
