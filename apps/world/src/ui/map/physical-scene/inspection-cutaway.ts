import type { PhysicalMesh } from './geometry.ts'
import { inverse, transform, type Vector3 } from './math.ts'

const last = new WeakMap<ReadonlyArray<PhysicalMesh>, { readonly signature: string; readonly meshes: ReadonlyArray<PhysicalMesh> }>()

/** Architectural foreground is an orientation policy, not physical face culling.
 * The same enclosure sides stay cut during pan/zoom, including close elevated
 * views whose eye lies inside a wall's XY plane. Local metre transforms are
 * uniform: the negative clip-W gradient points toward the perspective viewer. */
export const visiblePhysicalInspectionBoundaries = (meshes: ReadonlyArray<PhysicalMesh>, matrix: ArrayLike<number>): ReadonlyArray<PhysicalMesh> => {
  if (!meshes.some(mesh => mesh.inspectionPart !== undefined)) return meshes
  let towardViewer: Vector3 = [-matrix[3]!, -matrix[7]!, -matrix[11]!]
  if (towardViewer.every(value => value === 0)) {
    const camera = inverse(matrix), near = transform(camera, [0, 0, -1]), middle = transform(camera, [0, 0, 0])
    towardViewer = near.map((value, axis) => value - middle[axis]!) as unknown as Vector3
  }
  const facing = new Map<string, boolean>()
  for (const mesh of meshes) if (mesh.inspectionPart !== undefined && !facing.has(mesh.object.id)) {
    const normal = mesh.object.inspectionBoundary?.outward
    if (!normal) throw Error('A prepared inspection boundary has no authored outward direction')
    facing.set(mesh.object.id, towardViewer.reduce((value, coordinate, axis) => value + coordinate * normal[axis]!, 0) > 0)
  }
  const signature = JSON.stringify([...facing]), previous = last.get(meshes)
  if (previous?.signature === signature) return previous.meshes
  const selected = meshes.filter(mesh => mesh.inspectionPart === undefined || mesh.inspectionPart === (facing.get(mesh.object.id) ? 'cut' : 'full'))
  last.set(meshes, { signature, meshes: selected }); return selected
}
