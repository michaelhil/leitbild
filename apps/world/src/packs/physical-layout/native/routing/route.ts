import type { RouteBounds, RoutePoint } from './source.ts'

export interface RoutingObstacle extends RouteBounds { readonly id: string }
export interface RouteEnd { readonly point: RoutePoint; readonly outward: RoutePoint; readonly obstacleId?: string }
export interface PhysicalRouteRequest {
  readonly id: string; readonly from: RouteEnd; readonly to: RouteEnd
  readonly envelope: RouteBounds; readonly obstacles: ReadonlyArray<RoutingObstacle>
  readonly radius: number; readonly clearance: number; readonly bendRadius: number
  readonly via?: ReadonlyArray<RoutePoint>
}
export interface PhysicalRoutedPath {
  readonly id: string; readonly points: ReadonlyArray<RoutePoint>; readonly length: number
  readonly bends: number; readonly visited: number
}
const same = (a: RoutePoint, b: RoutePoint) => a.every((v, i) => v === b[i])
const inside = (p: RoutePoint, box: RouteBounds, strict = false) => p.every((v, i) => strict ? v > box.min[i]! && v < box.max[i]! : v >= box.min[i]! && v <= box.max[i]!)
const axisOf = (a: RoutePoint, b: RoutePoint) => a.findIndex((v, i) => v !== b[i])
const distance = (a: RoutePoint, b: RoutePoint) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0)
const expand = (box: RoutingObstacle, amount: number): RoutingObstacle => ({ id: box.id, min: box.min.map(v => v - amount) as unknown as RoutePoint, max: box.max.map(v => v + amount) as unknown as RoutePoint })

/** Positive interior intersection, including diagonal nozzle stubs. A route may
 * touch a clearance boundary; it cannot enter the reserved solid. */
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
interface QueueNode { readonly key: string; readonly index: readonly [number, number, number]; readonly axis: number; readonly score: number; readonly cost: number }
const queue = () => {
  const data: QueueNode[] = []
  const before = (a: QueueNode, b: QueueNode) => a.score < b.score || a.score === b.score && (a.cost < b.cost || a.cost === b.cost && a.key < b.key)
  return {
    push(value: QueueNode) { let i = data.length; data.push(value); while (i > 0) { const parent = (i - 1) >> 1; if (!before(value, data[parent]!)) break; data[i] = data[parent]!; i = parent }; data[i] = value },
    pop(): QueueNode | undefined { const first = data[0], last = data.pop(); if (!first || !data.length) return first; let i = 0; while (i * 2 + 1 < data.length) { let child = i * 2 + 1; if (child + 1 < data.length && before(data[child + 1]!, data[child]!)) child++; if (!before(data[child]!, last!)) break; data[i] = data[child]!; i = child }; data[i] = last!; return first },
  }
}
const simplify = (points: ReadonlyArray<RoutePoint>): RoutePoint[] => {
  const result: RoutePoint[] = []
  for (const p of points) {
    if (result.length && same(result.at(-1)!, p)) continue
    if (result.length > 1 && axisOf(result.at(-2)!, result.at(-1)!) === axisOf(result.at(-1)!, p)) result.pop()
    result.push(p)
  }
  return result
}
/** Exact obstacle-face coordinate arrangement, explored lazily. No voxel size,
 * search-count limit, maximum plant size, or hidden straight-line fallback.
 * A* includes incoming axis so bends carry a physical radius-derived cost. */
const routeLeg = (id: string, start: RoutePoint, end: RoutePoint, envelope: RouteBounds, obstacles: ReadonlyArray<RoutingObstacle>, bendRadius: number): { points: RoutePoint[]; visited: number } => {
  if (!inside(start, envelope) || !inside(end, envelope)) throw new Error(`Routing endpoint outside envelope: ${id}`)
  if (obstacles.some(box => inside(start, box, true) || inside(end, box, true))) throw new Error(`Routing endpoint blocked by clearance envelope: ${id}`)
  const axes = [0, 1, 2].map(axis => [...new Set([start[axis]!, end[axis]!, envelope.min[axis]!, envelope.max[axis]!, ...obstacles.flatMap(box => [box.min[axis]!, box.max[axis]!])].filter(v => v >= envelope.min[axis]! && v <= envelope.max[axis]!))].sort((a, b) => a - b))
  const index = (point: RoutePoint) => point.map((value, axis) => axes[axis]!.indexOf(value)) as [number, number, number]
  const point = (indices: readonly number[]): RoutePoint => indices.map((value, axis) => axes[axis]![value]!) as unknown as RoutePoint
  const key = (indices: readonly number[], axis: number) => `${indices.join(',')}/${axis}`
  const begin = index(start), goal = index(end), open = queue(), costs = new Map<string, number>(), previous = new Map<string, string>(), nodes = new Map<string, RoutePoint>()
  const first = key(begin, -1); costs.set(first, 0); nodes.set(first, start); open.push({ key: first, index: begin, axis: -1, cost: 0, score: distance(start, end) })
  let visited = 0
  for (let current = open.pop(); current; current = open.pop()) {
    if (current.cost !== costs.get(current.key)) continue
    visited++
    const p = point(current.index)
    if (current.index.every((v, a) => v === goal[a])) { const result: RoutePoint[] = []; for (let k: string | undefined = current.key; k !== undefined; k = previous.get(k)) result.push(nodes.get(k)!); return { points: simplify(result.reverse()), visited } }
    for (let axis = 0; axis < 3; axis++) for (const direction of [-1, 1]) {
      const indices = [...current.index] as [number, number, number]; indices[axis]! += direction
      if (indices[axis]! < 0 || indices[axis]! >= axes[axis]!.length) continue
      const next = point(indices)
      if (obstacles.some(box => physicalRouteIntersects(p, next, box))) continue
      const nextKey = key(indices, axis), cost = current.cost + distance(p, next) + (current.axis >= 0 && current.axis !== axis ? bendRadius : 0)
      if (cost >= (costs.get(nextKey) ?? Infinity)) continue
      costs.set(nextKey, cost); previous.set(nextKey, current.key); nodes.set(nextKey, next)
      open.push({ key: nextKey, index: indices, axis, cost, score: cost + distance(next, end) })
    }
  }
  throw new Error(`No clearance-safe 3D route exists in the authored envelope: ${id}`)
}

export const routePhysicalConnection = (request: PhysicalRouteRequest): PhysicalRoutedPath => {
  if (![request.radius, request.bendRadius].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(request.clearance) || request.clearance < 0) throw new Error(`Invalid routing dimensions: ${request.id}`)
  for (const end of [request.from, request.to]) if (end.outward.reduce((sum, v) => sum + Math.abs(v), 0) !== 1 || end.outward.some(v => v !== 0 && Math.abs(v) !== 1)) throw new Error(`Routing terminal needs an orthogonal outward direction: ${request.id}`)
  const margin = request.radius + request.clearance + request.bendRadius
  const obstacles = request.obstacles.filter(box => box.min.every((v, a) => v <= request.envelope.max[a]! + margin) && box.max.every((v, a) => v >= request.envelope.min[a]! - margin)).map(box => expand(box, margin))
  const lead = (end: RouteEnd): RoutePoint => {
    const own = obstacles.find(box => box.id === end.obstacleId), axis = end.outward.findIndex(v => v !== 0), sign = end.outward[axis]!
    const result = [...end.point] as [number, number, number]
    result[axis] = own ? (sign > 0 ? Math.max(end.point[axis]!, own.max[axis]!) : Math.min(end.point[axis]!, own.min[axis]!)) : end.point[axis]! + sign * margin
    if (obstacles.some(box => box.id !== end.obstacleId && physicalRouteIntersects(end.point, result, box))) throw new Error(`Routing nozzle exit is blocked: ${request.id}`)
    return result
  }
  const start = lead(request.from), end = lead(request.to), anchors = [start, ...(request.via ?? []), end], points: RoutePoint[] = [request.from.point]; let visited = 0
  for (let i = 1; i < anchors.length; i++) { const leg = routeLeg(request.id, anchors[i - 1]!, anchors[i]!, request.envelope, obstacles, request.bendRadius); points.push(...leg.points); visited += leg.visited }
  points.push(request.to.point)
  const path = simplify(points)
  return { id: request.id, points: path, length: path.slice(1).reduce((sum, p, i) => sum + distance(path[i]!, p), 0), bends: Math.max(0, path.length - 2), visited }
}

/** Quadratic corner transitions stay inside the reserved radius envelope. The
 * chord tolerance is supplied by the downstream authored geometry accuracy. */
export const roundedPhysicalRoute = (points: ReadonlyArray<RoutePoint>, radius: number, chordTolerance: number): ReadonlyArray<RoutePoint> => {
  if (!(radius > 0) || !(chordTolerance > 0)) throw new Error('Rounded routes require positive radius and geometric tolerance')
  const result: RoutePoint[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!, before = distance(a, b), after = distance(b, c), r = Math.min(radius, before / 2, after / 2)
    const p = b.map((v, axis) => v + (a[axis]! - v) * r / before) as unknown as RoutePoint, q = b.map((v, axis) => v + (c[axis]! - v) * r / after) as unknown as RoutePoint
    result.push(p)
    // For the quadratic, maximum midpoint chord error <= r/(2*n²).
    const steps = Math.ceil(Math.sqrt(r / (2 * chordTolerance)))
    for (let step = 1; step < steps; step++) { const t = step / steps; result.push(b.map((v, axis) => (1 - t) ** 2 * p[axis]! + 2 * t * (1 - t) * v + t * t * q[axis]!) as unknown as RoutePoint) }
    result.push(q)
  }
  if (points.length > 1) result.push(points.at(-1)!)
  return result
}
