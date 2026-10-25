import type { PhysicalMesh } from './geometry.ts'
import type { PhysicalLayerEntry } from './layer.ts'
import { localMercatorMatrix, multiply, type Vector3 } from './math.ts'
import { derivePhysicalPickAcceleration } from './picking.ts'

interface Envelope { readonly min: Vector3; readonly max: Vector3; readonly priority: number }
const envelopes = new WeakMap<ReadonlyArray<PhysicalMesh>, Envelope>()
const offsets = new WeakMap<ReadonlyArray<PhysicalMesh>, { readonly span: number; readonly meshes: ReadonlyArray<PhysicalMesh> }>()
const envelope = (meshes: ReadonlyArray<PhysicalMesh>): Envelope => {
  const cached = envelopes.get(meshes); if (cached) return cached
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let priority = 0
  for (const mesh of meshes) {
    priority = Math.max(priority, mesh.planPriority ?? 0)
    for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, mesh.bounds.min[axis]! + mesh.offset[axis]!); max[axis] = Math.max(max[axis]!, mesh.bounds.max[axis]! + mesh.offset[axis]!) }
  }
  const result = { min, max, priority }; envelopes.set(meshes, result); return result
}
type Point = readonly [number, number]
/** Clip the authored XY envelope to the actual camera frustum before choosing depth scale. */
const visibleMinimumW = (matrix: Float64Array, bounds: Envelope): number => {
  let polygon: ReadonlyArray<Point> = [[bounds.min[0], bounds.min[1]], [bounds.max[0], bounds.min[1]], [bounds.max[0], bounds.max[1]], [bounds.min[0], bounds.max[1]]]
  const value = (point: Point, row: number) => matrix[row]! * point[0] + matrix[row + 4]! * point[1] + matrix[row + 12]!
  for (const [row, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]] as const) {
    const clipped: Point[] = [], distance = (point: Point) => value(point, 3) + sign * value(point, row)
    polygon.forEach((a, index) => {
      const b = polygon[(index + 1) % polygon.length]!, da = distance(a), db = distance(b)
      if (da >= 0) clipped.push(a)
      if ((da >= 0) !== (db >= 0)) { const fraction = da / (da - db); clipped.push([a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])]) }
    })
    polygon = clipped; if (!polygon.length) return Infinity
  }
  return Math.min(...polygon.map(point => value(point, 3)).filter(w => w > 0))
}

/** Plan has an illustration depth domain; physical source heights remain unchanged. */
export const projectPhysicalPlan = (entries: ReadonlyArray<PhysicalLayerEntry>, mainMatrix: ArrayLike<number>): ReadonlyArray<{ readonly entry: PhysicalLayerEntry; readonly matrix: Float64Array; readonly meshes: ReadonlyArray<PhysicalMesh> }> => {
  const source = entries.filter(entry => entry.meshes.length).map(entry => ({ entry, bounds: envelope(entry.meshes), matrix: multiply(mainMatrix, localMercatorMatrix(entry.scene.anchor, entry.scene.bearing)) }))
  if (!source.length) return []
  const low = Math.min(...source.map(value => value.bounds.min[2])), high = Math.max(...source.map(value => value.bounds.max[2])), span = high > low ? high - low : 1
  const priority = Math.max(...source.map(value => value.bounds.priority)), domain = (2 * priority + 3) * span
  const scale = Math.min(...source.map(value => visibleMinimumW(value.matrix, value.bounds)))
  if (!(scale > 0) || !Number.isFinite(scale)) return []
  return source.map(({ entry, matrix }) => {
    // XY/W project the common geographic ground plane. Each semantic band has
    // one full authored-height span and an empty separating span; the two end
    // spans keep valid surfaces away from near/far depth boundary quantization.
    matrix[8] = 0; matrix[9] = 0; matrix[11] = 0; matrix[2] = 0; matrix[6] = 0
    matrix[10] = -2 * scale / domain; matrix[14] = scale - 2 * scale * (span - low) / domain
    let display = offsets.get(entry.meshes)
    if (!display || display.span !== span) {
      const meshes = entry.meshes.map(mesh => ({ ...mesh, offset: [mesh.offset[0], mesh.offset[1], mesh.offset[2] + 2 * (mesh.planPriority ?? 0) * span] as Vector3 }))
      if (entry.asset) derivePhysicalPickAcceleration(meshes, entry.asset.acceleration)
      display = { span, meshes }; offsets.set(entry.meshes, display)
    }
    return { entry, matrix, meshes: display.meshes }
  })
}
