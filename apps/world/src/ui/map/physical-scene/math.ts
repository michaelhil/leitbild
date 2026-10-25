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

export const rayBox = (origin: Vector3, direction: Vector3, bounds: PhysicalSceneBounds): number | null => {
  let low = 0, high = Infinity
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis]!, o = origin[axis]!
    if (Math.abs(d) < 1e-10) { if (o < bounds.min[axis]! || o > bounds.max[axis]!) return null; continue }
    const a = (bounds.min[axis]! - o) / d, b = (bounds.max[axis]! - o) / d
    low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b))
    if (low > high) return null
  }
  return low
}

export const rayTriangle = (origin: Vector3, direction: Vector3, a: Vector3, b: Vector3, c: Vector3): number | null => {
  const e1 = subtract(b, a), e2 = subtract(c, a), p = cross(direction, e2), determinant = dot(e1, p)
  if (Math.abs(determinant) < 1e-9) return null
  const reciprocal = 1 / determinant, t = subtract(origin, a), u = dot(t, p) * reciprocal
  if (u < 0 || u > 1) return null
  const q = cross(t, e1), v = dot(direction, q) * reciprocal
  if (v < 0 || u + v > 1) return null
  const distance = dot(e2, q) * reciprocal
  return distance >= 0 ? distance : null
}
