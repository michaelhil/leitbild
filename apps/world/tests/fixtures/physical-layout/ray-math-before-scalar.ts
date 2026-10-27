// Source b313507ea, math.ts SHA-256 fae79036b79cf003b40fcae44c09a44bef3dff7be6ffce0ba3df368227a3d10c.
// Frozen pre-scalar ray predicates; test-only numerical oracle.
import type { PhysicalSceneBounds } from '../../../src/core/packs/scene.ts'
import type { Vector3 } from '../../../src/ui/map/physical-scene/math.ts'
export { inverse, normalize, subtract, transform } from '../../../src/ui/map/physical-scene/math.ts'
const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
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
