import type { PhysicalMesh } from './geometry.ts'
import { inverse, transform, type Vector3 } from './math.ts'

const last = new WeakMap<ReadonlyArray<PhysicalMesh>, { readonly signature: string; readonly meshes: ReadonlyArray<PhysicalMesh> }>()

/** Local camera coordinates follow the same matrix used for real painting and
 * picking. Authored enclosure normals choose which boundary faces the viewer;
 * no wall IDs, screen side, source mutation or camera-driven preparation. */
export const visiblePhysicalInspectionBoundaries = (meshes: ReadonlyArray<PhysicalMesh>, matrix: ArrayLike<number>): ReadonlyArray<PhysicalMesh> => {
  if (!meshes.some(mesh => mesh.inspectionPart !== undefined)) return meshes
  const camera = inverse(matrix), perspective = camera[11] !== 0
  const eye: Vector3 = perspective ? [camera[8]! / camera[11]!, camera[9]! / camera[11]!, camera[10]! / camera[11]!] : transform(camera, [0, 0, -1])
  const far = perspective ? null : transform(camera, [0, 0, 1]), facing = new Map<string, boolean>()
  for (const mesh of meshes) if (mesh.inspectionPart !== undefined && !facing.has(mesh.object.id)) {
    const normal = mesh.object.inspectionBoundary?.outward
    if (!normal) throw Error('A prepared inspection boundary has no authored outward direction')
    const bounds = mesh.object.bounds ?? mesh.bounds
    const towardEye = far ? eye.map((value, axis) => value - far[axis]!) : eye.map((value, axis) => value - (bounds.min[axis]! + bounds.max[axis]!) / 2 - mesh.offset[axis]!)
    facing.set(mesh.object.id, towardEye.reduce((value, coordinate, axis) => value + coordinate * normal[axis]!, 0) > 0)
  }
  const signature = JSON.stringify([...facing]), previous = last.get(meshes)
  if (previous?.signature === signature) return previous.meshes
  const selected = meshes.filter(mesh => mesh.inspectionPart === undefined || mesh.inspectionPart === (facing.get(mesh.object.id) ? 'cut' : 'full'))
  last.set(meshes, { signature, meshes: selected }); return selected
}
