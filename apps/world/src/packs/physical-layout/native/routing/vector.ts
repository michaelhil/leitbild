import type { RouteBounds, RoutePoint } from './source.ts'

export const same = (a: RoutePoint, b: RoutePoint) => a.every((v, i) => v === b[i])
export const pointKey = (p: RoutePoint) => p.join(',')
export const inside = (p: RoutePoint, box: RouteBounds, strict = false) => p.every((v, i) => strict ? v > box.min[i]! && v < box.max[i]! : v >= box.min[i]! && v <= box.max[i]!)
export const subtract = (a: RoutePoint, b: RoutePoint): RoutePoint => a.map((v, i) => v - b[i]!) as unknown as RoutePoint
export const dot = (a: RoutePoint, b: RoutePoint) => a.reduce((sum, v, i) => sum + v * b[i]!, 0)
export const cross = (a: RoutePoint, b: RoutePoint): RoutePoint => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const magnitude = (p: RoutePoint) => Math.hypot(...p)
export const distance = (a: RoutePoint, b: RoutePoint) => magnitude(subtract(a, b))
export const manhattan = (a: RoutePoint, b: RoutePoint) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0)
export const scale = (p: RoutePoint, amount: number): RoutePoint => p.map(v => v * amount) as unknown as RoutePoint
export const unit = (p: RoutePoint): RoutePoint => scale(p, 1 / magnitude(p))
/** Forward error of normalized-vector arithmetic, not a geometric clearance. */
export const enough = (actual: number, required: number, operationScale = 1) => actual >= required || Number.isFinite(actual) && Number.isFinite(required) && required - actual <= 32 * Number.EPSILON * Math.max(Math.abs(operationScale), Math.abs(actual), Math.abs(required))
export const direction = (code: number): RoutePoint => [0, 1, 2].map(axis => axis === Math.floor(code / 2) ? code % 2 ? 1 : -1 : 0) as unknown as RoutePoint
export const bendTrim = (a: RoutePoint, b: RoutePoint, radius: number): number => {
  const sine = magnitude(cross(a, b)), cosine = dot(a, b)
  if (sine <= 32 * Number.EPSILON) return cosine < 0 ? Infinity : 0
  return radius * sine / (1 + cosine)
}
/** Positive interior intersection. Touching a reserved boundary is allowed. */
export const physicalRouteIntersects = (a: RoutePoint, b: RoutePoint, box: RouteBounds): boolean => {
  let low = 0, high = 1
  for (let axis = 0; axis < 3; axis++) {
    const d = b[axis]! - a[axis]!, start = a[axis]!
    if (!d) { if (start <= box.min[axis]! || start >= box.max[axis]!) return false; continue }
    const x = (box.min[axis]! - start) / d, y = (box.max[axis]! - start) / d
    low = Math.max(low, Math.min(x, y)); high = Math.min(high, Math.max(x, y))
    if (low >= high) return false
  }
  return low < high && high > 0 && low < 1
}
export const simplify = (points: ReadonlyArray<RoutePoint>, protectedPoints = new Set<string>()): RoutePoint[] => {
  const result: RoutePoint[] = []
  for (const p of points) {
    if (result.length && same(result.at(-1)!, p)) continue
    if (result.length > 1 && !protectedPoints.has(pointKey(result.at(-1)!))) {
      const a = subtract(result.at(-1)!, result.at(-2)!), b = subtract(p, result.at(-1)!)
      if (dot(a, b) > 0 && magnitude(cross(a, b)) <= 32 * Number.EPSILON * magnitude(a) * magnitude(b)) result.pop()
    }
    result.push(p)
  }
  return result
}
export const onSegment = (p: RoutePoint, a: RoutePoint, b: RoutePoint) => {
  const segment = subtract(b, a), delta = subtract(p, a), length = magnitude(segment)
  const coordinateScale = Math.max(...p.map(Math.abs), ...a.map(Math.abs), ...b.map(Math.abs)), operationScale = Math.max(magnitude(delta) * length, coordinateScale * length)
  if (!length) return magnitude(delta) <= 32 * Number.EPSILON * coordinateScale
  return magnitude(cross(delta, segment)) <= 32 * Number.EPSILON * operationScale && enough(dot(delta, segment), 0, operationScale) && enough(length * length, dot(delta, segment), operationScale)
}
