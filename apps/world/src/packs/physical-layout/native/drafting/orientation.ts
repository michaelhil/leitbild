import type { RenderObject } from '../explorer/architecture.ts'

/** Old Y-up recipes retained outward normals while reflecting vertex positions
 * into their authoring chart. Canonicalize each face before the declared frame
 * conversion. New foundation/tube recipes already agree and need no reversal.
 * All coordinates, material associations and outward normals remain identical. */
export const orientPhysicalFaces = (source: RenderObject): RenderObject => {
  let positions: number[] | null = null, normals: number[] | null = null, materials: number[] | null = null
  for (let at = 0; at < source.positions.length; at += 9) {
    const p = source.positions, n = source.normals
    const ax = p[at + 3]! - p[at]!, ay = p[at + 4]! - p[at + 1]!, az = p[at + 5]! - p[at + 2]!, bx = p[at + 6]! - p[at]!, by = p[at + 7]! - p[at + 1]!, bz = p[at + 8]! - p[at + 2]!
    const facing = (ay * bz - az * by) * (n[at]! + n[at + 3]! + n[at + 6]!) + (az * bx - ax * bz) * (n[at + 1]! + n[at + 4]! + n[at + 7]!) + (ax * by - ay * bx) * (n[at + 2]! + n[at + 5]! + n[at + 8]!)
    if (facing >= 0) continue
    if (!positions) { positions = [...p]; normals = [...n]; materials = [...source.materialIndices] }
    for (let axis = 0; axis < 3; axis++) {
      positions[at + 3 + axis] = p[at + 6 + axis]!; positions[at + 6 + axis] = p[at + 3 + axis]!
      normals![at + 3 + axis] = n[at + 6 + axis]!; normals![at + 6 + axis] = n[at + 3 + axis]!
    }
    materials![at / 3 + 1] = source.materialIndices[at / 3 + 2]!; materials![at / 3 + 2] = source.materialIndices[at / 3 + 1]!
  }
  return positions ? { ...source, positions, normals: normals!, materialIndices: materials! } : source
}
