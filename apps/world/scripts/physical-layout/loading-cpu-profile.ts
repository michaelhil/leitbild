import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { physicalSourceSchema } from '../../src/packs/physical-layout/native/explorer/source.ts'
import { compilePhysicalObjects, compilePhysicalScene, physicalObjectsBounds } from '../../src/packs/physical-layout/native/explorer/compile-scene.ts'
import { preparePhysicalGeometry } from '../../src/ui/map/physical-scene/preparation.ts'
import { visiblePhysicalSurfaceOwners } from '../../src/ui/map/physical-scene/surface-ownership.ts'
import { defaultPhysicalSceneView } from '../../src/ui/map/physical-scene/types.ts'
import { physicalSpatialBytes } from '../../src/ui/map/physical-scene/spatial-index.ts'
const root = join(import.meta.dir, '../..')
const records: unknown[] = []
for (const name of ['pwr-full-unit-explorer', 'pwr-campus-explorer']) {
  const raw = await Bun.file(join(root, 'src/packs/physical-layout', `${name}.source.json`)).text(), source = physicalSourceSchema.parse(JSON.parse(raw)), input = { source, bindings: [] }, objects = compilePhysicalObjects(input)
  const scene = compilePhysicalScene(name, { ...input, design: { digest: createHash('sha256').update(raw).digest('hex') }, owner: { objectId: 'diagnostic-only' }, placement: { anchor: [11.47,59.087], bearing: 0 }, bounds: physicalObjectsBounds(objects) })
  for (const variant of name.includes('full-unit') ? [{ levelId:'all', separation:0 },{ levelId:'operating',separation:0 },{ levelId:'all',separation:1 }] : [{levelId:'all',separation:0}]) {
    const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const, ...variant }, values: unknown[] = []
    for (const [kind, prepare] of [['profiled',preparePhysicalGeometry]] as const) {
      Bun.gc(true); const start = performance.now(), asset = prepare(scene,view,`${name}/${JSON.stringify(variant)}/${kind}`), ms = performance.now()-start
      const selected = visiblePhysicalSurfaceOwners(asset.meshes,asset.acceleration)
      values.push({kind,ms,sourceObjects:scene.objects.length,preparedFragments:asset.meshes.length,displayedFragments:selected.length,triangles:asset.buffers.vertices.length/24,renderBytes:asset.buffers.vertices.byteLength+asset.buffers.lines.byteLength,indexBytes:physicalSpatialBytes(asset.acceleration.meshes)+asset.acceleration.triangles.reduce((sum,index)=>sum+physicalSpatialBytes(index.triangles),0),ownership:'surfaceOwnership' in asset?asset.surfaceOwnership:undefined})
    }
    records.push({source:name,sourceSha256:scene.revision,variant,values})
  }
}
console.log(JSON.stringify({at:new Date().toISOString(),bun:Bun.version,rendererRoot:root,records,limits:['Single sequential pure CPU preparation pass after source compilation, with GC outside each timed region; not a warm-camera or product benchmark.','Diagnostic source binding list is empty; admitted physical source and compile profiles are unchanged.']},null,2))
