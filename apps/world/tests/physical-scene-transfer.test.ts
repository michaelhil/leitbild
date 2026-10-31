import { describe, expect, test } from 'bun:test'
import { packPhysicalSceneSchema, type PackPhysicalScene } from '../src/core/packs/scene.ts'
import { copyPhysicalSceneForTransfer } from '../src/core/packs/scene-transfer.ts'

const fixture = (): PackPhysicalScene => ({
  id: 'layout/one', revision: 'exact/revision', targetObjectId: 'owner/one', anchor: [11.47, 59.087], bearing: 30,
  bounds: { min: [-1, -1, 0], max: [2, 2, 1] }, levels: [{ id: 'lower', label: 'Lower', elevation: 0, cutHeight: 0.8 }],
  group: { id: 'site', label: 'Site' }, scopes: [{ id: 'building', kind: 'building', label: 'Building', bounds: { min: [-1, -1, 0], max: [2, 2, 1] }, levelIds: ['lower'] }],
  layers: [{ id: 'equipment', label: 'Equipment', defaultVisible: true }],
  objects: [{ id: 'pump', label: 'Pump', kind: 'equipment', levelId: 'lower', scopeIds: ['building'], levelIds: ['lower'], layerId: 'equipment',
    positions: [0.123456789012345, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
    material: 'steel', materials: ['steel', 'motor'], materialIndices: [0, 1, 0], subjectIds: ['pump/subject'],
    featureLines: [{ positions: [0, 0, 0, 1, 0, 0], material: 'line' }],
    planLines: [{ positions: [0, 0, 0, 0, 1, 0], material: 'door' }], edgePolicy: 'authored',
  }],
})

const numericValues = (scene: PackPhysicalScene) => scene.objects.map(object => ({
  positions: Array.from(object.positions), normals: object.normals && Array.from(object.normals), indices: object.indices && Array.from(object.indices),
  materialIndices: object.materialIndices && Array.from(object.materialIndices),
  featureLines: object.featureLines?.map(line => Array.from(line.positions)), planLines: object.planLines?.map(line => Array.from(line.positions)),
}))

describe('Physical scene transferable storage', () => {
  test('retained JSON geometry and typed delivery preserve exactly the same values and metadata', () => {
    const original = packPhysicalSceneSchema.parse(fixture()), delivery = copyPhysicalSceneForTransfer(original)
    expect(Array.isArray(original.objects[0]!.positions)).toBe(true)
    const scene = packPhysicalSceneSchema.parse(delivery.scene), object = scene.objects[0]!
    expect(object.positions).toBeInstanceOf(Float64Array)
    expect(object.normals).toBeInstanceOf(Float64Array)
    expect(object.indices).toBeInstanceOf(Uint32Array)
    expect(object.materialIndices).toBeInstanceOf(Uint32Array)
    expect(object.featureLines![0]!.positions).toBeInstanceOf(Float64Array)
    expect(object.planLines![0]!.positions).toBeInstanceOf(Float64Array)
    expect(numericValues(scene)).toEqual(numericValues(original))
    expect({ ...scene, objects: [] }).toEqual({ ...original, objects: [] })
    expect({ ...object, positions: [], normals: [], indices: [], materialIndices: [], featureLines: [], planLines: [] })
      .toEqual({ ...original.objects[0]!, positions: [], normals: [], indices: [], materialIndices: [], featureLines: [], planLines: [] })
  })

  test('typed geometry retains finite, topology, normal, palette and stroke validation', () => {
    const reject = (edit: (scene: PackPhysicalScene) => void): void => {
      const scene = copyPhysicalSceneForTransfer(fixture()).scene
      edit(scene)
      expect(packPhysicalSceneSchema.safeParse(scene).success).toBe(false)
    }
    reject(scene => { scene.objects[0]!.positions[0] = NaN })
    reject(scene => { scene.objects[0]!.positions[0] = Infinity })
    reject(scene => { scene.objects[0]!.normals![0] = -Infinity })
    reject(scene => { scene.objects[0]!.positions = new Float64Array([0, 0]) })
    reject(scene => { scene.objects[0]!.indices = new Uint32Array([0, 1]) })
    reject(scene => { scene.objects[0]!.indices = new Uint32Array([0, 1, 3]) })
    reject(scene => { scene.objects[0]!.normals = new Float64Array([0, 0, 1]) })
    reject(scene => { scene.objects[0]!.materialIndices = new Uint32Array([0, 1]) })
    reject(scene => { scene.objects[0]!.materialIndices = new Uint32Array([0, 2, 0]) })
    reject(scene => { scene.objects[0]!.featureLines![0]!.positions = new Float64Array([0, 0, 0]) })
    reject(scene => { scene.objects[0]!.planLines![0]!.positions[0] = NaN })
    reject(scene => { scene.objects[0]!.planLines![0]!.positions = new Float64Array([0, 0, 0]) })
    expect(packPhysicalSceneSchema.safeParse({ ...fixture(), objects: [{ ...fixture().objects[0], positions: new Float32Array(9) }] }).success).toBe(false)
    expect(packPhysicalSceneSchema.safeParse({ ...fixture(), objects: [{ ...fixture().objects[0], indices: [-1, 1, 2] }] }).success).toBe(false)
    expect(packPhysicalSceneSchema.safeParse({ ...fixture(), objects: [{ ...fixture().objects[0], indices: [0, 1.5, 2] }] }).success).toBe(false)
  })

  test('owned copies deduplicate repeated arrays and transfer without detaching caller geometry', () => {
    const original = copyPhysicalSceneForTransfer(fixture()).scene, object = original.objects[0]!
    object.planLines = object.featureLines!
    const before = numericValues(original), positions = object.positions, feature = object.featureLines![0]!.positions
    const delivery = copyPhysicalSceneForTransfer(original)
    expect(delivery.scene.objects[0]!.positions).not.toBe(positions)
    expect(delivery.scene.objects[0]!.featureLines![0]!.positions).not.toBe(feature)
    expect(delivery.scene.objects[0]!.featureLines![0]!.positions).toBe(delivery.scene.objects[0]!.planLines![0]!.positions)
    expect(new Set(delivery.transfers).size).toBe(delivery.transfers.length)
    expect(delivery.transfers).toHaveLength(5)
    const received = packPhysicalSceneSchema.parse(structuredClone(delivery.scene, { transfer: delivery.transfers }))
    expect(delivery.transfers.every(buffer => buffer.byteLength === 0)).toBe(true)
    expect(numericValues(original)).toEqual(before)
    expect(numericValues(received)).toEqual(before)
    expect(positions.length).toBe(9)
    expect(feature.length).toBe(6)
  })

  test('a real module worker sends transferred typed storage and retains its caller-owned input', async () => {
    const input = copyPhysicalSceneForTransfer(fixture()).scene, before = numericValues(input)
    const worker = new Worker(new URL('./fixtures/physical-scene-transfer.worker.ts', import.meta.url), { type: 'module' })
    try {
      const result = await new Promise<{ scene: PackPhysicalScene; detached: boolean; inputIntact: boolean }>((resolve, reject) => {
        let scene: PackPhysicalScene | undefined
        let receipt: { detached: boolean; inputIntact: boolean } | undefined
        worker.onerror = event => reject(new Error(event.message))
        worker.onmessage = event => {
          try {
            if (event.data.scene) scene = packPhysicalSceneSchema.parse(event.data.scene)
            else receipt = event.data
            if (scene && receipt) resolve({ scene, ...receipt })
          } catch (error) { reject(error) }
        }
        worker.postMessage(input)
      })
      expect(result.detached).toBe(true)
      expect(result.inputIntact).toBe(true)
      expect(result.scene.objects[0]!.positions).toBeInstanceOf(Float64Array)
      expect(result.scene.objects[0]!.indices).toBeInstanceOf(Uint32Array)
      expect(numericValues(result.scene)).toEqual(before)
      expect(numericValues(input)).toEqual(before)
    } finally { worker.terminate() }
  })
})
