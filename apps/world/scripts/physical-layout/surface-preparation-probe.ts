import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { physicalSourceSchema } from '../../src/packs/physical-layout/native/explorer/source.ts'
import { compilePhysicalObjects, compilePhysicalScene, physicalObjectsBounds } from '../../src/packs/physical-layout/native/explorer/compile-scene.ts'
import { preparePhysicalGeometry } from '../../src/ui/map/physical-scene/preparation.ts'
import { visiblePhysicalSurfaceOwners } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'
import { physicalSpatialBytes } from '../../src/ui/map/physical-scene/spatial-index.ts'
const root = join(import.meta.dir, '../..'), baselineRoot = process.env.LEITBILD_PHYSICAL_BASELINE_ROOT
if (!baselineRoot) throw Error('Set LEITBILD_PHYSICAL_BASELINE_ROOT to the frozen pre-correction apps/world checkout')
const baseline = await import(join(baselineRoot, 'src/ui/map/physical-scene/preparation.ts')) as { preparePhysicalGeometry: typeof preparePhysicalGeometry }
const fingerprint = (asset: ReturnType<typeof preparePhysicalGeometry>, includeBroadPhase = true): string => {
  const hash=createHash('sha256'), binary=(values:ArrayLike<number>)=>hash.update(new Uint8Array(Float64Array.from(values).buffer))
  for(const mesh of asset.meshes){hash.update(JSON.stringify([mesh.key,mesh.assetIndex,mesh.levelId,mesh.planPriority,mesh.offset,mesh.bounds,mesh.occludedBy??[],mesh.lineMaterials,mesh.lineStyles,mesh.object.id,mesh.object.subjectIds,mesh.object.material,mesh.object.materials,mesh.object.scopeIds,mesh.object.layerId]));binary(mesh.vertices);binary(mesh.lines)}
  for(const index of[asset.acceleration.meshes,...asset.acceleration.triangles.map(value=>value.triangles)])for(const values of[index.bounds,index.children,index.ranges,index.order])binary(values)
  const ownership = includeBroadPhase ? asset.surfaceOwnership : {...asset.surfaceOwnership,broadPhaseCandidates:undefined}
  binary(asset.buffers.vertices);binary(asset.buffers.lines);hash.update(JSON.stringify([asset.buffers.roles,ownership]));return hash.digest('hex')
}
const records: unknown[] = []
for (const name of ['pwr-full-unit-explorer', 'pwr-campus-explorer']) {
  const raw = await Bun.file(join(root, 'src/packs/physical-layout', `${name}.source.json`)).text(), source = physicalSourceSchema.parse(JSON.parse(raw)), input = { source, bindings: [] }, objects = compilePhysicalObjects(input)
  const scene = compilePhysicalScene(name, { ...input, design: { digest: createHash('sha256').update(raw).digest('hex') }, owner: { objectId: 'diagnostic-only' }, placement: { anchor: [11.47,59.087], bearing: 0 }, bounds: physicalObjectsBounds(objects) })
  const variants = name.includes('full-unit')
    ? [{ mode:'3d' as const,levelId:'all',separation:0 },{ mode:'3d' as const,levelId:'operating',separation:0 },{ mode:'3d' as const,levelId:'all',separation:1 },{ mode:'2d' as const,levelId:'operating',separation:0 },{ mode:'3d' as const,levelId:'all',separation:0,cutaway:false }]
    : [{ mode:'3d' as const,levelId:'all',separation:0 },{ mode:'3d' as const,levelId:'all',separation:0,cutaway:false }]
  for (const variant of variants) {
    const view = { ...defaultPhysicalSceneView(scene.levels), ...variant }, values: unknown[] = [], fingerprints: string[] = [], geometryFingerprints: string[] = []
    for (const [kind, prepare] of [['baseline',baseline.preparePhysicalGeometry],['candidate',preparePhysicalGeometry]] as const) {
      Bun.gc(true); const start = performance.now(), asset = prepare(scene,view,`${name}/${JSON.stringify(variant)}/${kind}`), ms = performance.now()-start
      const selected = visiblePhysicalSurfaceOwners(asset.meshes)
      const preparedSha256 = fingerprint(asset), geometrySha256 = fingerprint(asset,false); fingerprints.push(preparedSha256); geometryFingerprints.push(geometrySha256)
      values.push({kind,ms,preparedSha256,geometrySha256,sourceObjects:scene.objects.length,preparedFragments:asset.meshes.length,displayedFragments:selected.length,triangles:asset.buffers.vertices.length/24,renderBytes:asset.buffers.vertices.byteLength+asset.buffers.lines.byteLength,indexBytes:physicalSpatialBytes(asset.acceleration.meshes)+asset.acceleration.triangles.reduce((sum,index)=>sum+physicalSpatialBytes(index.triangles),0),ownership:'surfaceOwnership' in asset?asset.surfaceOwnership:undefined})
    }
    const byteEquivalent = fingerprints[0] === fingerprints[1], geometryEquivalent = geometryFingerprints[0] === geometryFingerprints[1]
    records.push({source:name,sourceSha256:scene.revision,variant,byteEquivalent,geometryEquivalent,values})
    if (process.env.LEITBILD_PHYSICAL_REQUIRE_EQUIVALENT === '1' && !(process.env.LEITBILD_PHYSICAL_BROAD_PHASE_CHANGED === '1' ? geometryEquivalent : byteEquivalent)) throw Error(`Prepared output changed for ${name}/${JSON.stringify(variant)}`)
  }
}
console.log(JSON.stringify({at:new Date().toISOString(),bun:Bun.version,baselineRoot,rendererRoot:root,records,limits:['Single sequential pure CPU preparation pass after source compilation, with GC outside each timed region; not a warm-camera or product benchmark.','Diagnostic source binding list is empty; admitted physical source and compile profiles are unchanged.']},null,2))
