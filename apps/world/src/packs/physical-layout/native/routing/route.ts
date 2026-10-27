import type { RouteBounds, RoutePoint } from './source.ts'
import { same, inside, pointKey, unit, scale, dot, cross, distance, magnitude, enough, onSegment, simplify, subtract, physicalRouteIntersects } from './vector.ts'
import { searchPhysicalRoute } from './search.ts'
import { physicalFilletTrims } from './round.ts'
export { physicalRouteIntersects } from './vector.ts'
export { roundedPhysicalRoute } from './round.ts'

export interface RoutingObstacle extends RouteBounds { readonly id: string }
export interface RouteEnd { readonly point: RoutePoint; readonly outward: RoutePoint; readonly obstacleId?: string }
export interface PhysicalRouteRequest {
  readonly id: string; readonly from: RouteEnd; readonly to: RouteEnd
  /** Authored centreline search domain; the resulting tube has its own physical bounds. */
  readonly envelope: RouteBounds; readonly obstacles: ReadonlyArray<RoutingObstacle>
  readonly radius: number; readonly clearance: number; readonly bendRadius: number
  /** Ordered centreline points, preserved as straight-through tangencies. */
  readonly via?: ReadonlyArray<RoutePoint>
}
export interface PhysicalRoutedPath {
  readonly id: string; readonly points: ReadonlyArray<RoutePoint>
  /** Unrounded control-polyline length; circular fillets shorten this length. */
  readonly length: number; readonly bends: number; readonly visited: number
}
const expand = (box: RoutingObstacle, amount: number): RoutingObstacle => ({ id: box.id, min: box.min.map(v => v - amount) as unknown as RoutePoint, max: box.max.map(v => v + amount) as unknown as RoutePoint })

const prepare = (request: PhysicalRouteRequest) => {
  if (![request.radius, request.bendRadius].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(request.clearance) || request.clearance < 0) throw Error(`Invalid routing dimensions: ${request.id}`)
  const validPoint = (p: RoutePoint) => p.length === 3 && p.every(Number.isFinite)
  for (const bounds of [request.envelope, ...request.obstacles]) if (!validPoint(bounds.min) || !validPoint(bounds.max) || bounds.min.some((v, axis) => v >= bounds.max[axis]!)) throw Error(`Routing bounds need finite positive volume: ${request.id}`)
  if (new Set(request.obstacles.map(box => box.id)).size !== request.obstacles.length) throw Error(`Duplicate routing obstacle: ${request.id}`)
  const ends = [request.from, request.to].map(end => {
    if (!validPoint(end.point) || !validPoint(end.outward) || !Number.isFinite(magnitude(end.outward)) || !enough(magnitude(end.outward), 1) || !enough(1, magnitude(end.outward))) throw Error(`Routing terminal needs a finite unit outward direction: ${request.id}`)
    if (!inside(end.point, request.envelope)) throw Error(`Routing terminal outside centreline envelope: ${request.id}`)
    if (end.obstacleId && !request.obstacles.some(box => box.id === end.obstacleId)) throw Error(`Routing terminal names an unknown obstacle: ${request.id}`)
    return { ...end, outward: unit(end.outward) }
  }) as [RouteEnd, RouteEnd]
  if (request.via?.some(p => !validPoint(p))) throw Error(`Routing waypoints must be finite: ${request.id}`)
  const margin = request.radius + request.clearance + request.bendRadius
  if (!Number.isFinite(margin)) throw Error(`Routing clearance is not representable: ${request.id}`)
  const obstacles = request.obstacles.filter(box => box.min.every((v, a) => v <= request.envelope.max[a]! + margin) && box.max.every((v, a) => v >= request.envelope.min[a]! - margin)).map(box => expand(box, margin))
  const lead = (end: RouteEnd): RoutePoint => {
    const own = obstacles.find(box => box.id === end.obstacleId)
    let length = margin, exitFace: { readonly distance: number; readonly axis: number; readonly coordinate: number } | undefined
    if (own && inside(end.point, own)) {
      const faces = end.outward.flatMap((v, axis) => v ? [{ distance: ((v > 0 ? own.max : own.min)[axis]! - end.point[axis]!) / v, axis, coordinate: (v > 0 ? own.max : own.min)[axis]! }] : [])
      exitFace = faces.reduce((first, next) => next.distance < first.distance ? next : first)
      length = Math.max(length, exitFace.distance)
    }
    const result = end.point.map((v, axis) => v + end.outward[axis]! * length) as [number, number, number]
    // Canonical ray/plane intersection, as in polygon clipping: retain the exact
    // authored face coordinate instead of rounding an exit back into its box.
    if (exitFace && length === exitFace.distance) result[exitFace.axis] = exitFace.coordinate
    if (obstacles.some(box => box.id !== end.obstacleId && physicalRouteIntersects(end.point, result, box) || box.id === end.obstacleId && !inside(end.point, box) && physicalRouteIntersects(end.point, result, box))) throw Error(`Routing nozzle exit is blocked: ${request.id}`)
    return result
  }
  return { from: ends[0], to: ends[1], obstacles, lead }
}
const aligned = (a: RoutePoint, b: RoutePoint, operationScale = 1) => dot(a, b) > 0 && magnitude(cross(a, b)) <= 32 * Number.EPSILON * operationScale

/** Validate retained authoring output without invoking the path search. Cold
 * delivery checks current ports, exact waypoints, clearance and true-radius
 * feasibility; changing a source constraint cannot silently retain a stale path. */
export const validatePhysicalConnectionRoute = (request: PhysicalRouteRequest, accepted: ReadonlyArray<RoutePoint>): { readonly length: number; readonly bends: number } => {
  const { from, to, obstacles } = prepare(request), { points, trims } = physicalFilletTrims(accepted, request.bendRadius)
  if (points.length < 2 || points.length !== accepted.length) throw Error(`Accepted route contains a zero-length segment: ${request.id}`)
  if (!same(points[0]!, from.point) || !same(points.at(-1)!, to.point)) throw Error(`Accepted route endpoints differ from current terminals: ${request.id}`)
  if (points.some(point => !inside(point, request.envelope))) throw Error(`Accepted route escapes its centreline envelope: ${request.id}`)
  const directions = points.slice(1).map((p, index) => unit(subtract(p, points[index]!))), lastDirection = scale(to.outward, -1)
  const alignmentScale = (index: number) => Math.max(1, ...points[index]!.map(Math.abs), ...points[index + 1]!.map(Math.abs)) / Math.min(1, distance(points[index]!, points[index + 1]!))
  if (!aligned(directions[0]!, from.outward, alignmentScale(0)) || !aligned(directions.at(-1)!, lastDirection, alignmentScale(directions.length - 1))) throw Error(`Accepted route violates a terminal outward direction: ${request.id}`)
  let prefixEnd = 0, suffixStart = points.length - 1
  while (prefixEnd < directions.length && aligned(directions[prefixEnd]!, from.outward, alignmentScale(prefixEnd))) prefixEnd++
  while (suffixStart > 0 && aligned(directions[suffixStart - 1]!, lastDirection, alignmentScale(suffixStart - 1))) suffixStart--
  for (let i = prefixEnd; i < suffixStart; i++) if (subtract(points[i + 1]!, points[i]!).filter(value => value !== 0).length !== 1) throw Error(`Accepted route has a nonorthogonal middle run: ${request.id}`)
  if (prefixEnd < directions.length && !enough(dot(from.outward, directions[prefixEnd]!), 0) || suffixStart > 0 && !enough(dot(directions[suffixStart - 1]!, lastDirection), 0)) throw Error(`Accepted route turns back into its nozzle escape: ${request.id}`)
  for (const obstacle of obstacles) {
    if (obstacle.id === from.obstacleId && inside(points[prefixEnd]!, obstacle, true) || obstacle.id === to.obstacleId && inside(points[suffixStart]!, obstacle, true)) throw Error(`Accepted nozzle stub does not exit its own equipment envelope: ${request.id}`)
    for (let i = 0; i < directions.length; i++) {
      if (obstacle.id === from.obstacleId && i < prefixEnd || obstacle.id === to.obstacleId && i >= suffixStart) continue
      if (physicalRouteIntersects(points[i]!, points[i + 1]!, obstacle)) throw Error(`Accepted route violates reserved obstacle clearance: ${request.id}/${obstacle.id}`)
    }
  }
  let previous = -1
  for (const waypoint of request.via ?? []) {
    let found = false
    for (let i = 0; i < directions.length; i++) {
      const a = points[i]!.map((value, axis) => value + directions[i]![axis]! * trims[i]!) as unknown as RoutePoint, b = points[i + 1]!.map((value, axis) => value - directions[i]![axis]! * trims[i + 1]!) as unknown as RoutePoint
      if (!onSegment(waypoint, a, b)) continue
      const span = subtract(b, a), squared = dot(span, span), fraction = squared ? Math.max(0, Math.min(1, dot(subtract(waypoint, a), span) / squared)) : 0, at = i + fraction
      if (!enough(at, previous)) continue
      previous = at; found = true; break
    }
    if (!found) throw Error(`Accepted route misses or reorders a required straight-through waypoint: ${request.id}`)
  }
  return { length: points.slice(1).reduce((sum, p, i) => sum + distance(points[i]!, p), 0), bends: trims.filter(value => value > 0).length }
}

export const routePhysicalConnection = (request: PhysicalRouteRequest): PhysicalRoutedPath => {
  const { from, to, obstacles, lead } = prepare(request), start = lead(from), end = lead(to), pending = [...request.via ?? []], protectedPoints = new Set(pending.map(pointKey))
  const prefix: RoutePoint[] = [], suffix: RoutePoint[] = []
  while (pending.length && onSegment(pending[0]!, from.point, start) && (!prefix.length || distance(from.point, pending[0]!) >= distance(from.point, prefix.at(-1)!))) prefix.push(pending.shift()!)
  while (pending.length && onSegment(pending.at(-1)!, end, to.point) && (!suffix.length || distance(end, pending.at(-1)!) <= distance(end, suffix[0]!))) suffix.unshift(pending.pop()!)
  const result = searchPhysicalRoute({ id: request.id, start, end, from, to, envelope: request.envelope, obstacles, radius: request.bendRadius, via: pending, startViaRoom: prefix.length ? distance(prefix.at(-1)!, start) : Infinity, endViaRoom: suffix.length ? distance(end, suffix[0]!) : Infinity })
  const path = simplify([from.point, ...prefix, ...result.points, ...suffix, to.point], protectedPoints)
  if (path.length < 2 || same(path[0]!, path[1]!)) throw Error(`A connection needs a nonzero routed centreline: ${request.id}`)
  return { id: request.id, points: path, ...validatePhysicalConnectionRoute(request, path), visited: result.visited }
}
