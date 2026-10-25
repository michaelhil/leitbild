import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { PhysicalMesh } from './geometry.ts'
import { inverse, normalize, rayBox, rayTriangle, subtract, transform, type Vector3 } from './math.ts'
import { createPhysicalSpatialIndex, visitPhysicalSpatialRay, type PhysicalSpatialIndex } from './spatial-index.ts'

export interface PhysicalPickEntry { readonly sceneId: string; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly matrix: ArrayLike<number> }
export interface PhysicalMeshAcceleration { readonly triangles: PhysicalSpatialIndex }
export interface PhysicalPickAcceleration { readonly meshes: PhysicalSpatialIndex; readonly triangles: ReadonlyArray<PhysicalMeshAcceleration> }
const meshIndices = new WeakMap<PhysicalMesh, PhysicalMeshAcceleration>()
const sceneIndices = new WeakMap<ReadonlyArray<PhysicalMesh>, PhysicalPickAcceleration>()
const inverses = new WeakMap<ArrayLike<number>, Float64Array>()
const vertex = (mesh: PhysicalMesh, at: number): Vector3 => [mesh.vertices[at]!, mesh.vertices[at + 1]!, mesh.vertices[at + 2]!]
export const preparePhysicalMeshAcceleration = (mesh: PhysicalMesh): PhysicalMeshAcceleration => {
  const cached = meshIndices.get(mesh)
  if (cached) return cached
  const bounds: PhysicalSceneBounds[] = []
  for (let at = 0; at < mesh.vertices.length; at += 21) {
    const a = vertex(mesh, at), b = vertex(mesh, at + 7), c = vertex(mesh, at + 14)
    bounds.push({ min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])], max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])] })
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
        const at = primitive * 21, distance = rayTriangle(local, direction, vertex(mesh, at), vertex(mesh, at + 7), vertex(mesh, at + 14))
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
