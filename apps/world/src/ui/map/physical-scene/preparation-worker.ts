import { preparePhysicalGeometry, type PhysicalPreparationRequest, type PhysicalPreparationResponse } from './preparation.ts'
import { packPhysicalSceneSchema } from '../../../core/packs/scene.ts'
const scope = self as unknown as { onmessage: (event: MessageEvent<PhysicalPreparationRequest>) => void; postMessage: (message: PhysicalPreparationResponse, transfers?: Transferable[]) => void }
scope.onmessage = (event: MessageEvent<PhysicalPreparationRequest>) => {
  const request = event.data
  try {
    const scene = packPhysicalSceneSchema.parse(request.scene), prepared = preparePhysicalGeometry(scene, request.view, request.key), byId = new Map(scene.objects.map((object, index) => [object.id, index]))
    const meshes = prepared.meshes.map(({ object, ...mesh }) => ({ ...mesh, objectIndex: byId.get(object.id)! }))
    const transfers: Transferable[] = []
    for (const mesh of meshes) { if (mesh.vertices instanceof Float64Array) transfers.push(mesh.vertices.buffer); if (mesh.lines instanceof Float64Array) transfers.push(mesh.lines.buffer) }
    for (const index of [prepared.acceleration.meshes, ...prepared.acceleration.triangles.map(item => item.triangles)]) transfers.push(index.bounds.buffer, index.children.buffer, index.ranges.buffer, index.order.buffer)
    scope.postMessage({ id: request.id, key: request.key, meshes, acceleration: prepared.acceleration } satisfies PhysicalPreparationResponse, transfers)
  } catch (error) { scope.postMessage({ id: request.id, key: request.key, error: error instanceof Error ? error.message : String(error) } satisfies PhysicalPreparationResponse) }
}
