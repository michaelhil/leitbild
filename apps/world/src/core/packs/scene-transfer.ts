import type { PackPhysicalScene } from './scene.ts'

/** Copy validated delivery geometry into owned transferable buffers; never detach the caller's asset. */
export const copyPhysicalSceneForTransfer = (scene: PackPhysicalScene): { scene: PackPhysicalScene; transfers: ArrayBuffer[] } => {
  const transfers = new Set<ArrayBuffer>()
  const coordinates = new Map<number[] | Float64Array, Float64Array<ArrayBuffer>>()
  const indices = new Map<number[] | Uint32Array, Uint32Array<ArrayBuffer>>()
  const coordinateCopy = (values: number[] | Float64Array): Float64Array<ArrayBuffer> => {
    const existing = coordinates.get(values)
    if (existing) return existing
    const owned = new Float64Array(values)
    coordinates.set(values, owned); transfers.add(owned.buffer)
    return owned
  }
  const indexCopy = (values: number[] | Uint32Array): Uint32Array<ArrayBuffer> => {
    const existing = indices.get(values)
    if (existing) return existing
    const owned = new Uint32Array(values)
    indices.set(values, owned); transfers.add(owned.buffer)
    return owned
  }
  const objects = scene.objects.map(object => ({ ...object,
    positions: coordinateCopy(object.positions),
    ...(object.normals === undefined ? {} : { normals: coordinateCopy(object.normals) }),
    ...(object.indices === undefined ? {} : { indices: indexCopy(object.indices) }),
    ...(object.materialIndices === undefined ? {} : { materialIndices: indexCopy(object.materialIndices) }),
    ...(object.featureLines === undefined ? {} : { featureLines: object.featureLines.map(line => ({ ...line, positions: coordinateCopy(line.positions) })) }),
    ...(object.planLines === undefined ? {} : { planLines: object.planLines.map(line => ({ ...line, positions: coordinateCopy(line.positions) })) }),
  }))
  return { scene: { ...scene, objects }, transfers: [...transfers] }
}
