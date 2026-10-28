import { expect, test } from 'bun:test'
import { packPhysicalSceneSchema } from '../src/core/packs/scene.ts'
import { copyPhysicalSceneForTransfer } from '../src/core/packs/scene-transfer.ts'
import { preparePhysicalGeometry, type PhysicalPreparationRequest, type PhysicalPreparationResponse } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

test('the private preparation worker consumes an admitted owned scene without changing geometry, picks or source lifecycle', async () => {
  const scene = packPhysicalSceneSchema.parse({
    id: 'layout', revision: 'source', targetObjectId: 'owner', anchor: [10, 60], bearing: 0,
    bounds: { min: [0, 0, 0], max: [2, 2, 1] }, levels: [{ id: 'ground', label: 'Ground', elevation: 0, cutHeight: 1 }],
    objects: [{ id: 'equipment', label: 'Equipment', kind: 'equipment', levelId: 'ground', subjectIds: ['subject'], materials: ['steel'],
      positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], materialIndices: [0, 0, 0],
      edgePolicy: 'authored', featureLines: [{ positions: [0, 0, 0, 2, 0, 0], material: 'line' }],
    }],
  })
  const view = { ...defaultPhysicalSceneView(scene.levels), mode: '3d' as const }, expected = preparePhysicalGeometry(scene, view, 'view', 'identity')
  const worker = new Worker(new URL('../src/ui/map/physical-scene/preparation-worker.ts', import.meta.url), { type: 'module' })
  const request = (message: PhysicalPreparationRequest, transfers: Transferable[] = []) => new Promise<PhysicalPreparationResponse>((resolve, reject) => {
    worker.onerror = event => reject(Error(event.message))
    worker.onmessage = event => resolve(event.data as PhysicalPreparationResponse)
    worker.postMessage(message, transfers)
  })
  try {
    const copy = copyPhysicalSceneForTransfer(scene)
    expect(await request({ kind: 'register', id: 1, sourceKey: 'source', scene: copy.scene }, copy.transfers)).toEqual({ kind: 'registered', id: 1, sourceKey: 'source' })
    expect(copy.transfers.every(buffer => buffer.byteLength === 0)).toBe(true)
    expect(scene.objects[0]!.positions).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0])
    const result = await request({ kind: 'prepare', id: 2, key: 'view', identity: 'identity', sourceKey: 'source', view })
    if (result.kind !== 'prepared') throw Error(`Expected prepared scene, received ${result.kind}`)
    expect(result.meshes.map(({ objectIndex, ...mesh }) => ({ ...mesh, object: scene.objects[objectIndex]! }))).toEqual([...expected.meshes])
    expect(result.buffers).toEqual(expected.buffers)
    expect(result.acceleration).toEqual(expected.acceleration)
    expect(result.surfaceOwnership).toEqual(expected.surfaceOwnership)
    const duplicate = copyPhysicalSceneForTransfer(scene)
    expect(await request({ kind: 'register', id: 3, sourceKey: 'source', scene: duplicate.scene }, duplicate.transfers)).toEqual({ kind: 'error', id: 3, message: 'Physical source identity was already registered' })
    // Release and the following request are delivered in order to the same port.
    worker.postMessage({ kind: 'release', sourceKey: 'source' } satisfies PhysicalPreparationRequest)
    expect(await request({ kind: 'prepare', id: 4, key: 'view', identity: 'identity', sourceKey: 'source', view })).toEqual({ kind: 'error', id: 4, message: 'Physical preparation source is not registered' })
    const fresh = copyPhysicalSceneForTransfer(scene)
    expect(await request({ kind: 'register', id: 5, sourceKey: 'source', scene: fresh.scene }, fresh.transfers)).toEqual({ kind: 'registered', id: 5, sourceKey: 'source' })
  } finally { worker.terminate() }
})
