import { preparePhysicalGeometry, type PhysicalPreparationRequest, type PhysicalPreparationResponse } from './preparation.ts'
import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
const scope = self as unknown as { onmessage: (event: MessageEvent<PhysicalPreparationRequest>) => void; postMessage: (message: PhysicalPreparationResponse, transfers?: Transferable[]) => void }
const sources = new Map<string, PackPhysicalScene>()
scope.onmessage = (event: MessageEvent<PhysicalPreparationRequest>) => {
  const request = event.data
  if (request.kind === 'release') { sources.delete(request.sourceKey); return }
  try {
    if (request.kind === 'register') {
      if (sources.has(request.sourceKey)) throw new Error('Physical source identity was already registered')
      // This private module worker receives only the pool's owned transferable
      // copy of a Pack-admitted scene (or its locally derived overview). Source
      // admission stays at the Pack boundary; reconstructing its full schema
      // here repeats that work and loads validation modules into a render worker.
      sources.set(request.sourceKey, request.scene); scope.postMessage({ kind: 'registered', id: request.id, sourceKey: request.sourceKey }); return
    }
    const scene = sources.get(request.sourceKey)
    if (!scene) throw new Error('Physical preparation source is not registered')
    const prepared = preparePhysicalGeometry(scene, request.view, request.key, request.identity), byId = new Map(scene.objects.map((object, index) => [object.id, index]))
    const meshes = prepared.meshes.map(({ object, ...mesh }) => ({ ...mesh, objectIndex: byId.get(object.id)! }))
    const transfers: Transferable[] = []
    for (const mesh of meshes) { if (mesh.vertices instanceof Float64Array) transfers.push(mesh.vertices.buffer); if (mesh.lines instanceof Float64Array) transfers.push(mesh.lines.buffer) }
    for (const index of [prepared.acceleration.meshes, ...prepared.acceleration.triangles.map(item => item.triangles)]) transfers.push(index.bounds.buffer, index.children.buffer, index.ranges.buffer, index.order.buffer)
    transfers.push(prepared.buffers.vertices.buffer, prepared.buffers.lines.buffer)
    scope.postMessage({ kind: 'prepared', id: request.id, key: request.key, sourceKey: request.sourceKey, identity: prepared.identity, meshes, acceleration: prepared.acceleration, buffers: prepared.buffers, surfaceOwnership: prepared.surfaceOwnership }, transfers)
  } catch (error) { scope.postMessage({ kind: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) }) }
}
