import { materials } from './scenery-glb-visual-policy.ts'
import type { PrimitiveSpec } from './scenery-glb-types.ts'

const align4 = (value: number): number =>
  (value + 3) & ~3

const appendBytes = (
  chunks: Uint8Array[],
  bytes: Uint8Array,
): number => {
  const offset = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  chunks.push(bytes)
  const padding = align4(offset + bytes.byteLength) - (offset + bytes.byteLength)
  if (padding > 0) chunks.push(new Uint8Array(padding))
  return offset
}

const bytesForFloat32 = (values: Float32Array): Uint8Array =>
  new Uint8Array(values.buffer, values.byteOffset, values.byteLength)

const bytesForUint32 = (values: Uint32Array): Uint8Array =>
  new Uint8Array(values.buffer, values.byteOffset, values.byteLength)

export const minMaxForPrimitivePositions = (
  positions: Float32Array,
): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } => {
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index] ?? 0
    const y = positions[index + 1] ?? 0
    const z = positions[index + 2] ?? 0
    min[0] = Math.min(min[0], x)
    min[1] = Math.min(min[1], y)
    min[2] = Math.min(min[2], z)
    max[0] = Math.max(max[0], x)
    max[1] = Math.max(max[1], y)
    max[2] = Math.max(max[2], z)
  }
  return { min, max }
}

export const boundsForPrimitives = (
  primitives: ReadonlyArray<PrimitiveSpec>,
): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } => {
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const primitive of primitives) {
    const bounds = minMaxForPrimitivePositions(primitive.positions)
    min[0] = Math.min(min[0], bounds.min[0])
    min[1] = Math.min(min[1], bounds.min[1])
    min[2] = Math.min(min[2], bounds.min[2])
    max[0] = Math.max(max[0], bounds.max[0])
    max[1] = Math.max(max[1], bounds.max[1])
    max[2] = Math.max(max[2], bounds.max[2])
  }
  return Number.isFinite(min[0])
    ? { min, max }
    : { min: [0, 0, 0], max: [0, 0, 0] }
}

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export const glbFromPrimitives = (
  primitives: ReadonlyArray<PrimitiveSpec>,
): Uint8Array => {
  const chunks: Uint8Array[] = []
  const bufferViews: unknown[] = []
  const accessors: unknown[] = []
  const meshPrimitives: unknown[] = []
  const materialIndexByKey = new Map(materials.map((material, index) => [material.key, index]))

  for (const primitive of primitives) {
    const positionOffset = appendBytes(chunks, bytesForFloat32(primitive.positions))
    const normalOffset = appendBytes(chunks, bytesForFloat32(primitive.normals))
    const indexOffset = appendBytes(chunks, bytesForUint32(primitive.indices))

    const positionViewIndex = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: positionOffset, byteLength: primitive.positions.byteLength, target: 34962 })
    const normalViewIndex = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: normalOffset, byteLength: primitive.normals.byteLength, target: 34962 })
    const indexViewIndex = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: primitive.indices.byteLength, target: 34963 })

    const positionAccessorIndex = accessors.length
    const positionBounds = minMaxForPrimitivePositions(primitive.positions)
    accessors.push({
      bufferView: positionViewIndex,
      byteOffset: 0,
      componentType: 5126,
      count: primitive.positions.length / 3,
      type: 'VEC3',
      min: positionBounds.min,
      max: positionBounds.max,
    })
    const normalAccessorIndex = accessors.length
    accessors.push({
      bufferView: normalViewIndex,
      byteOffset: 0,
      componentType: 5126,
      count: primitive.normals.length / 3,
      type: 'VEC3',
    })
    const indexAccessorIndex = accessors.length
    accessors.push({
      bufferView: indexViewIndex,
      byteOffset: 0,
      componentType: 5125,
      count: primitive.indices.length,
      type: 'SCALAR',
    })

    meshPrimitives.push({
      attributes: {
        POSITION: positionAccessorIndex,
        NORMAL: normalAccessorIndex,
      },
      indices: indexAccessorIndex,
      material: materialIndexByKey.get(primitive.materialKey) ?? 0,
      extras: {
        name: primitive.name,
        droneSceneryKind: primitive.materialKey,
      },
    })
  }

  const bin = concatChunks(chunks)
  const json = {
    asset: {
      version: '2.0',
      generator: 'Leitbild scenery GLB compiler',
      copyright: '© OpenStreetMap contributors; derived scenery generated by Leitbild',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Leitbild scenery tile' }],
    meshes: [{ name: 'Leitbild scenery tile mesh', primitives: meshPrimitives }],
    materials: materials.map(material => ({
      name: material.name,
      pbrMetallicRoughness: {
        baseColorFactor: material.color,
        metallicFactor: material.metallicFactor ?? 0,
        roughnessFactor: material.roughnessFactor ?? 0.8,
      },
      extras: {
        droneSceneryMaterialKey: material.key,
        droneSceneryDepthPolicy: material.depthPolicy,
      },
      ...(material.doubleSided ? { doubleSided: true } : {}),
      ...(material.emissiveFactor ? { emissiveFactor: material.emissiveFactor } : {}),
    })),
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews,
    accessors,
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonChunkLength = align4(jsonBytes.byteLength)
  const binChunkLength = align4(bin.byteLength)
  const totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength
  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  view.setUint32(12, jsonChunkLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  output.fill(0x20, 20, 20 + jsonChunkLength)
  output.set(jsonBytes, 20)
  const binHeaderOffset = 20 + jsonChunkLength
  view.setUint32(binHeaderOffset, binChunkLength, true)
  view.setUint32(binHeaderOffset + 4, 0x004e4942, true)
  output.set(bin, binHeaderOffset + 8)
  return output
}
