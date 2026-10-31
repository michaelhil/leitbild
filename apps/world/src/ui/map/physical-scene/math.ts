import { MercatorCoordinate } from 'maplibre-gl'
import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'

export type Vector3 = readonly [number, number, number]
export const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const normalize = (v: Vector3): Vector3 => { const length = Math.hypot(...v); return length ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1] }

export const multiply = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array => {
  const output = new Float64Array(16)
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) output[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!
  return output
}

export const transform = (matrix: ArrayLike<number>, p: Vector3): Vector3 => {
  const w = matrix[3]! * p[0] + matrix[7]! * p[1] + matrix[11]! * p[2] + matrix[15]!
  return [0, 1, 2].map(row => (matrix[row]! * p[0] + matrix[4 + row]! * p[1] + matrix[8 + row]! * p[2] + matrix[12 + row]!) / w) as unknown as Vector3
}

export const inverse = (matrix: ArrayLike<number>): Float64Array => {
  const rows = Array.from({ length: 4 }, (_, row) => Array.from({ length: 8 }, (_, column) => column < 4 ? matrix[column * 4 + row]! : Number(column - 4 === row)))
  for (let column = 0; column < 4; column++) {
    let pivot = column
    for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row
    if (Math.abs(rows[pivot]![column]!) < 1e-20) throw new Error('Physical scene projection is singular')
    ;[rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!]
    const divisor = rows[column]![column]!
    for (let k = 0; k < 8; k++) rows[column]![k]! /= divisor
    for (let row = 0; row < 4; row++) if (row !== column) {
      const factor = rows[row]![column]!
      for (let k = 0; k < 8; k++) rows[row]![k]! -= factor * rows[column]![k]!
    }
  }
  return new Float64Array(Array.from({ length: 16 }, (_, index) => rows[index % 4]![4 + Math.floor(index / 4)]!))
}

/** Local east/north/up, rotated by a clockwise geographic bearing, with no latitude baked into geometry. */
export const localMercatorMatrix = (anchor: readonly [number, number], bearing: number): Float64Array => {
  const origin = MercatorCoordinate.fromLngLat([anchor[0], anchor[1]], 0)
  const scale = origin.meterInMercatorCoordinateUnits(), radians = bearing * Math.PI / 180
  const c = Math.cos(radians) * scale, s = Math.sin(radians) * scale
  return new Float64Array([c, s, 0, 0, s, -c, 0, 0, 0, 0, scale, 0, origin.x, origin.y, origin.z, 1])
}

export const boundsCorners = (bounds: PhysicalSceneBounds): Vector3[] => Array.from({ length: 8 }, (_, index) => [bounds[index & 1 ? 'max' : 'min'][0], bounds[index & 2 ? 'max' : 'min'][1], bounds[index & 4 ? 'max' : 'min'][2]])

/** Scalar bounds keep the same axis order and parallel tolerance as rayBox. */
export const rayBoxCoordinates = (origin: Vector3, direction: Vector3, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number | null => {
  let low = 0, high = Infinity
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis]!, o = origin[axis]!, min = axis === 0 ? minX : axis === 1 ? minY : minZ, max = axis === 0 ? maxX : axis === 1 ? maxY : maxZ
    if (Math.abs(d) < 1e-10) { if (o < min || o > max) return null; continue }
    const a = (min - o) / d, b = (max - o) / d
    low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b))
    if (low > high) return null
  }
  return low
}
export const rayBox = (origin: Vector3, direction: Vector3, bounds: PhysicalSceneBounds): number | null => rayBoxCoordinates(origin, direction, bounds.min[0], bounds.min[1], bounds.min[2], bounds.max[0], bounds.max[1], bounds.max[2])

/** One canonical Möller–Trumbore calculation. Keep the original subtraction,
 * cross/dot arithmetic order and determinant/barycentric/distance predicates. */
const rayTriangleCoordinates = (origin: Vector3, direction: Vector3, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number | null => {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az
  const px = direction[1] * e2z - direction[2] * e2y, py = direction[2] * e2x - direction[0] * e2z, pz = direction[0] * e2y - direction[1] * e2x
  const determinant = e1x * px + e1y * py + e1z * pz
  if (Math.abs(determinant) < 1e-9) return null
  const reciprocal = 1 / determinant, tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az, u = (tx * px + ty * py + tz * pz) * reciprocal
  if (u < 0 || u > 1) return null
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * reciprocal
  if (v < 0 || u + v > 1) return null
  const distance = (e2x * qx + e2y * qy + e2z * qz) * reciprocal
  return distance >= 0 ? distance : null
}
export const rayTriangle = (origin: Vector3, direction: Vector3, a: Vector3, b: Vector3, c: Vector3): number | null => rayTriangleCoordinates(origin, direction, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
/** Prepared triangles use three seven-value vertex records. Read their exact
 * position attributes directly without allocating three temporary vectors. */
export const rayTrianglePacked = (origin: Vector3, direction: Vector3, vertices: ArrayLike<number>, at: number): number | null => rayTriangleCoordinates(origin, direction, vertices[at]!, vertices[at + 1]!, vertices[at + 2]!, vertices[at + 7]!, vertices[at + 8]!, vertices[at + 9]!, vertices[at + 14]!, vertices[at + 15]!, vertices[at + 16]!)
