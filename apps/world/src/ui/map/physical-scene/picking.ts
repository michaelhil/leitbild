import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { PhysicalMesh } from './geometry.ts'
import { inverse, normalize, rayBox, rayTrianglePacked, subtract, transform, type Vector3 } from './math.ts'
import { createPhysicalSpatialIndex, visitPhysicalSpatialRay, type PhysicalSpatialIndex } from './spatial-index.ts'

export interface PhysicalPickEntry { readonly sceneId: string; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly matrix: ArrayLike<number> }
export interface PhysicalMeshAcceleration { readonly triangles: PhysicalSpatialIndex }
export interface PhysicalPickAcceleration { readonly meshes: PhysicalSpatialIndex; readonly triangles: ReadonlyArray<PhysicalMeshAcceleration> }
const meshIndices = new WeakMap<PhysicalMesh, PhysicalMeshAcceleration>()
const sceneIndices = new WeakMap<ReadonlyArray<PhysicalMesh>, PhysicalPickAcceleration>()
const inverses = new WeakMap<ArrayLike<number>, Float64Array>()
export const preparePhysicalMeshAcceleration = (mesh: PhysicalMesh): PhysicalMeshAcceleration => {
  const cached = meshIndices.get(mesh)
  if (cached) return cached
  const bounds: PhysicalSceneBounds[] = []
  for (let at = 0; at < mesh.vertices.length; at += 21) {
    const values = mesh.vertices
    bounds.push({ min: [Math.min(values[at]!, values[at + 7]!, values[at + 14]!), Math.min(values[at + 1]!, values[at + 8]!, values[at + 15]!), Math.min(values[at + 2]!, values[at + 9]!, values[at + 16]!)], max: [Math.max(values[at]!, values[at + 7]!, values[at + 14]!), Math.max(values[at + 1]!, values[at + 8]!, values[at + 15]!), Math.max(values[at + 2]!, values[at + 9]!, values[at + 16]!)] })
  }
  const result = { triangles: createPhysicalSpatialIndex(bounds) }; meshIndices.set(mesh, result); return result
}
export const preparePhysicalPickAcceleration = (meshes: ReadonlyArray<PhysicalMesh>): PhysicalPickAcceleration => {
  const cached = sceneIndices.get(meshes)
  if (cached) return cached
  const result = { meshes: createPhysicalSpatialIndex(meshes.map(mesh => ({ min: mesh.bounds.min.map((value, axis) => value + mesh.offset[axis]!) as [number, number, number], max: mesh.bounds.max.map((value, axis) => value + mesh.offset[axis]!) as [number, number, number] }))), triangles: meshes.map(preparePhysicalMeshAcceleration) }
  sceneIndices.set(meshes, result); return result
}
/** Attach worker-prepared indices only to the exact retained mesh array. */
export const admitPhysicalPickAcceleration = (meshes: ReadonlyArray<PhysicalMesh>, acceleration: PhysicalPickAcceleration): void => {
  if (acceleration.triangles.length !== meshes.length) throw new Error('Physical pick acceleration does not match its mesh array')
  sceneIndices.set(meshes, acceleration); meshes.forEach((mesh, index) => meshIndices.set(mesh, acceleration.triangles[index]!))
}
// Display-only offsets and filters reuse triangle trees and rebuild only their small broad phase.
export const derivePhysicalPickAcceleration = (meshes: ReadonlyArray<PhysicalMesh>, source: PhysicalPickAcceleration): void => {
  for (const mesh of meshes) { const index = mesh.assetIndex; if (index === undefined || !source.triangles[index]) throw new Error('Filtered physical fragment lost its source index'); meshIndices.set(mesh, source.triangles[index]!) }
  preparePhysicalPickAcceleration(meshes)
}
/** Explicit pointer intent only. It tests exactly the same cut fragments that draw. */
export const pickPhysicalMesh = (entries: ReadonlyArray<PhysicalPickEntry>, point: { x: number; y: number }, width: number, height: number): { sceneId: string; mesh: PhysicalMesh; position: Vector3; depth: number } | null => {
  if (width <= 0 || height <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  const clip: Vector3 = [point.x / width * 2 - 1, 1 - point.y / height * 2, -1]
  let nearest: ReturnType<typeof pickPhysicalMesh> = null
  for (const entry of entries) {
    let inverted = inverses.get(entry.matrix)
    if (!inverted) { inverted = inverse(entry.matrix); inverses.set(entry.matrix, inverted) }
    const origin = transform(inverted, clip), far = transform(inverted, [clip[0], clip[1], 1]), direction = normalize(subtract(far, origin)), acceleration = preparePhysicalPickAcceleration(entry.meshes), candidates: number[] = []
    visitPhysicalSpatialRay(acceleration.meshes, origin, direction, () => Infinity, index => { candidates.push(index) })
    candidates.sort((a, b) => a - b)
    let localNearest = Infinity
    for (const meshIndex of candidates) {
      const mesh = entry.meshes[meshIndex]!
      const local = subtract(origin, mesh.offset), boundsDistance = rayBox(local, direction, mesh.bounds)
      if (boundsDistance === null || boundsDistance > localNearest) continue
      let meshNearest = localNearest, triangleIndex = Infinity
      visitPhysicalSpatialRay(acceleration.triangles[meshIndex]!.triangles, local, direction, () => meshNearest, primitive => {
        const at = primitive * 21, distance = rayTrianglePacked(local, direction, mesh.vertices, at)
        if (distance === null || distance > meshNearest || distance === meshNearest && at >= triangleIndex) return
        meshNearest = distance; triangleIndex = at
      })
      if (meshNearest >= localNearest) continue
      localNearest = meshNearest
      const p: Vector3 = [origin[0] + direction[0] * localNearest, origin[1] + direction[1] * localNearest, origin[2] + direction[2] * localNearest], depth = transform(entry.matrix, p)[2]
      if (!nearest || depth < nearest.depth) nearest = { sceneId: entry.sceneId, mesh, position: p, depth }
    }
  }
  return nearest
}
