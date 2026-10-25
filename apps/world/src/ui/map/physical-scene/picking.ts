import type { PhysicalMesh } from './geometry.ts'
import { inverse, normalize, rayBox, rayTriangle, subtract, transform, type Vector3 } from './math.ts'

export interface PhysicalPickEntry { readonly sceneId: string; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly matrix: ArrayLike<number> }
/** Explicit pointer intent only. It tests exactly the same cut fragments that draw. */
export const pickPhysicalMesh = (entries: ReadonlyArray<PhysicalPickEntry>, point: { x: number; y: number }, width: number, height: number): { sceneId: string; mesh: PhysicalMesh; position: Vector3; depth: number } | null => {
  if (width <= 0 || height <= 0) return null
  const clip: Vector3 = [point.x / width * 2 - 1, 1 - point.y / height * 2, -1]
  let nearest: ReturnType<typeof pickPhysicalMesh> = null
  for (const entry of entries) {
    const inverted = inverse(entry.matrix), origin = transform(inverted, clip), far = transform(inverted, [clip[0], clip[1], 1]), direction = normalize(subtract(far, origin))
    let localNearest = Infinity
    for (const mesh of entry.meshes) {
      const local = subtract(origin, mesh.offset), boundsDistance = rayBox(local, direction, mesh.bounds)
      if (boundsDistance === null || boundsDistance > localNearest) continue
      for (let index = 0; index < mesh.vertices.length; index += 21) {
        const a = mesh.vertices.slice(index, index + 3) as unknown as Vector3, b = mesh.vertices.slice(index + 7, index + 10) as unknown as Vector3, c = mesh.vertices.slice(index + 14, index + 17) as unknown as Vector3
        const distance = rayTriangle(local, direction, a, b, c)
        if (distance === null || distance >= localNearest) continue
        localNearest = distance
        const p: Vector3 = [origin[0] + direction[0] * distance, origin[1] + direction[1] * distance, origin[2] + direction[2] * distance]
        const depth = transform(entry.matrix, p)[2]
        if (!nearest || depth < nearest.depth) nearest = { sceneId: entry.sceneId, mesh, position: p, depth }
      }
    }
  }
  return nearest
}
