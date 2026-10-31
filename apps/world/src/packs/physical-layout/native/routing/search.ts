import type { RouteBounds, RoutePoint } from './source.ts'
import type { RouteEnd, RoutingObstacle } from './route.ts'
import { inside, same, distance, manhattan, direction, dot, scale, bendTrim, enough, physicalRouteIntersects } from './vector.ts'

interface Node {
  readonly key: string; readonly index: readonly [number, number, number]
  readonly direction: number; readonly origin: number; readonly trim: number; readonly viaAt: number | null
  readonly progress: number; readonly score: number; readonly cost: number
}
const queue = () => {
  const data: Node[] = []
  const before = (a: Node, b: Node) => a.score < b.score || a.score === b.score && (a.cost < b.cost || a.cost === b.cost && a.key < b.key)
  return {
    push(value: Node) { let i = data.length; data.push(value); while (i > 0) { const parent = (i - 1) >> 1; if (!before(value, data[parent]!)) break; data[i] = data[parent]!; i = parent }; data[i] = value },
    pop(): Node | undefined { const first = data[0], last = data.pop(); if (!first || !data.length) return first; let i = 0; while (i * 2 + 1 < data.length) { let child = i * 2 + 1; if (child + 1 < data.length && before(data[child + 1]!, data[child]!)) child++; if (!before(data[child]!, last!)) break; data[i] = data[child]!; i = child }; data[i] = last!; return first },
  }
}
export interface SearchInput {
  readonly id: string; readonly start: RoutePoint; readonly end: RoutePoint; readonly from: RouteEnd; readonly to: RouteEnd
  readonly envelope: RouteBounds; readonly obstacles: ReadonlyArray<RoutingObstacle>; readonly radius: number
  readonly via: ReadonlyArray<RoutePoint>; readonly startViaRoom: number; readonly endViaRoom: number
}
/** Lazy obstacle-face arrangement. State retains signed direction, straight
 * length available to the next true-radius fillet and ordered via progress.
 * Once both trim budgets reach R, longer runs are physically equivalent and
 * share one state. This is geometric dominance, not a search/count limit. */
export const searchPhysicalRoute = (input: SearchInput): { points: RoutePoint[]; visited: number } => {
  const { id, start, end, from, to, envelope, obstacles, radius, via } = input
  for (const anchor of [start, ...via, end]) {
    if (!inside(anchor, envelope)) throw Error(`Routing endpoint or waypoint outside centreline envelope: ${id}`)
    if (obstacles.some(box => inside(anchor, box, true))) throw Error(`Routing endpoint or waypoint blocked by clearance envelope: ${id}`)
  }
  const anchors = [start, ...via, end]
  const axes = [0, 1, 2].map(axis => [...new Set([
    envelope.min[axis]!, envelope.max[axis]!,
    ...anchors.flatMap(p => [p[axis]!, p[axis]! - radius, p[axis]! + radius, p[axis]! - 2 * radius, p[axis]! + 2 * radius]),
    ...obstacles.flatMap(box => [box.min[axis]!, box.max[axis]!]),
  ].filter(v => v >= envelope.min[axis]! && v <= envelope.max[axis]!))].sort((a, b) => a - b))
  const index = (p: RoutePoint) => p.map((value, axis) => axes[axis]!.indexOf(value)) as [number, number, number]
  const point = (indices: readonly number[]): RoutePoint => indices.map((value, axis) => axes[axis]![value]!) as unknown as RoutePoint
  const begin = index(start), goal = index(end), open = queue(), costs = new Map<string, number>(), previous = new Map<string, string>(), nodes = new Map<string, RoutePoint>()
  const nextProgress = (p: RoutePoint, progress: number) => { while (progress < via.length && same(p, via[progress]!)) progress++; return progress }
  const budget = (node: Node, p: RoutePoint) => node.direction < 0 ? distance(from.point, start) : Math.abs(p[Math.floor(node.direction / 2)]! - node.origin) - node.trim
  const viaRoom = (node: Node, p: RoutePoint) => node.direction < 0 ? input.startViaRoom : node.viaAt === null ? radius : Math.abs(p[Math.floor(node.direction / 2)]! - node.viaAt)
  const roomEnough = (actual: number, required: number, p: RoutePoint, node: Node) => enough(actual, required, Math.max(...p.map(Math.abs), Math.abs(node.origin), Math.abs(node.viaAt ?? 0)))
  const key = (indices: readonly number[], dir: number, origin: number, trim: number, viaAt: number | null, progress: number) => {
    const p = point(indices), room = dir < 0 ? 0 : Math.abs(p[Math.floor(dir / 2)]! - origin) - trim, waypointRoom = dir < 0 ? 0 : viaAt === null ? radius : Math.abs(p[Math.floor(dir / 2)]! - viaAt)
    const operationScale = Math.max(...p.map(Math.abs), Math.abs(origin), Math.abs(viaAt ?? 0))
    return `${indices.join(',')}/${dir}/${progress}/${enough(room, radius, operationScale) && enough(waypointRoom, radius, operationScale) ? 'free' : `${origin},${trim},${viaAt}`}`
  }
  const heuristic = (p: RoutePoint, progress: number) => {
    const points = [p, ...via.slice(progress), end]
    return points.slice(1).reduce((sum, next, index) => sum + manhattan(points[index]!, next), 0)
  }
  const progress = nextProgress(start, 0), first = key(begin, -1, 0, 0, null, progress)
  costs.set(first, 0); nodes.set(first, start); open.push({ key: first, index: begin, direction: -1, origin: 0, trim: 0, viaAt: null, progress, cost: 0, score: heuristic(start, progress) })
  let visited = 0
  for (let current = open.pop(); current; current = open.pop()) {
    if (current.cost !== costs.get(current.key)) continue
    visited++
    const p = point(current.index), incoming = current.direction < 0 ? from.outward : direction(current.direction), finalDirection = scale(to.outward, -1)
    if (current.index.every((v, a) => v === goal[a]) && current.progress === via.length && enough(dot(incoming, finalDirection), 0)) {
      const trim = bendTrim(incoming, finalDirection, radius)
      const straightEnd = trim === 0 && current.direction >= 0, finalRoom = budget(current, p) + (straightEnd ? distance(end, to.point) : 0)
      const suffixFits = !straightEnd || !Number.isFinite(input.endViaRoom) || roomEnough(budget(current, p) + input.endViaRoom, 0, p, current)
      if (Number.isFinite(trim) && roomEnough(finalRoom, trim, p, current) && roomEnough(viaRoom(current, p), trim, p, current) && enough(distance(end, to.point), trim) && enough(input.endViaRoom, trim) && suffixFits) {
        const result: RoutePoint[] = []
        for (let k: string | undefined = current.key; k !== undefined; k = previous.get(k)) result.push(nodes.get(k)!)
        return { points: result.reverse(), visited }
      }
    }
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const dir = axis * 2 + (sign > 0 ? 1 : 0), outgoing = direction(dir)
      if (current.direction >= 0 && Math.floor(current.direction / 2) === axis && current.direction !== dir || current.direction < 0 && !enough(dot(incoming, outgoing), 0)) continue
      const indices = [...current.index] as [number, number, number]; indices[axis]! += sign
      if (indices[axis]! < 0 || indices[axis]! >= axes[axis]!.length) continue
      const next = point(indices)
      if (obstacles.some(box => physicalRouteIntersects(p, next, box))) continue
      const turning = current.direction !== dir, trim = turning ? bendTrim(incoming, outgoing, radius) : 0
      if (!Number.isFinite(trim) || trim > 0 && (!roomEnough(budget(current, p), trim, p, current) || !roomEnough(viaRoom(current, p), trim, p, current) || current.progress > 0 && same(p, via[current.progress - 1]!))) continue
      const initialStraight = current.direction < 0 && trim === 0
      const origin = initialStraight ? from.point[axis]! : turning ? p[axis]! : current.origin, startTrim = turning ? trim : current.trim
      const progress = enough(Math.abs(next[axis]! - origin), startTrim, Math.max(Math.abs(next[axis]!), Math.abs(origin))) ? nextProgress(next, current.progress) : current.progress
      const viaAt = progress !== current.progress ? next[axis]! : initialStraight && Number.isFinite(input.startViaRoom) ? start[axis]! - sign * input.startViaRoom : turning ? null : current.viaAt
      const nextKey = key(indices, dir, origin, startTrim, viaAt, progress), cost = current.cost + distance(p, next) + (trim > 0 ? radius : 0)
      if (cost >= (costs.get(nextKey) ?? Infinity)) continue
      costs.set(nextKey, cost); previous.set(nextKey, current.key); nodes.set(nextKey, next)
      open.push({ key: nextKey, index: indices, direction: dir, origin, trim: startTrim, viaAt, progress, cost, score: cost + heuristic(next, progress) })
    }
  }
  throw Error(`No admissible 3D route found in the authored orthogonal search arrangement: ${id}`)
}
