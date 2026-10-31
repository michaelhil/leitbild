import type { RoutePoint, RouteBounds } from './source.ts'
import { physicalFilletArc, physicalFilletJoints } from './round.ts'
import { distance, same, subtract, unit, enough } from './vector.ts'

interface Piece {
  readonly start: number; readonly length: number
  readonly point: (fraction: number) => RoutePoint
  readonly sagitta: (span: number) => number
}
interface Interval { readonly piece: Piece; readonly low: number; readonly high: number }
const roundoff = (...points: RoutePoint[]) => 32 * Number.EPSILON * Math.max(1, ...points.flatMap(point => point.map(Math.abs)))
const bounds = ({ piece, low, high }: Interval): RouteBounds => {
  const a = piece.point(low), b = piece.point(high), padding = piece.sagitta(high - low) + roundoff(a, b)
  return { min: a.map((value, axis) => Math.min(value, b[axis]!) - padding) as unknown as RoutePoint, max: a.map((value, axis) => Math.max(value, b[axis]!) + padding) as unknown as RoutePoint }
}
const separation = (a: Interval, b: Interval, total: number, closed: boolean) => {
  const low = b.piece.start + b.low * b.piece.length - a.piece.start - a.high * a.piece.length, high = b.piece.start + b.high * b.piece.length - a.piece.start - a.low * a.piece.length
  if (!closed) return { low, high }
  return { low: Math.min(low, total - high), high: low <= total / 2 && high >= total / 2 ? total / 2 : Math.max(Math.min(low, total - low), Math.min(high, total - high)) }
}

/** Conservative nonlocal tube self-clearance, using analytic circular pieces.
 * Local neighbours within πr of arclength belong to the same tube; with every
 * curvature radius > r they cannot be a nonlocal self-intersection. Other
 * pairs use sagitta bounds and actual point witnesses, subdividing only where
 * needed. There is no fixed sampling step, recursion depth or iteration cap. */
export const validatePhysicalRouteSelfClearance = (id: string, points: ReadonlyArray<RoutePoint>, trims: ReadonlyArray<number>, bendRadius: number, tubeRadius: number): void => {
  const directions = points.slice(1).map((point, index) => unit(subtract(point, points[index]!))), pieces: Piece[] = []
  const joints = physicalFilletJoints(points, trims)
  let total = 0
  for (let i = 0; i < directions.length; i++) {
    const a = joints[i] ?? points[i]!.map((value, axis) => value + directions[i]![axis]! * trims[i]!) as unknown as RoutePoint, b = joints[i] ?? points[i + 1]!.map((value, axis) => value - directions[i]![axis]! * trims[i + 1]!) as unknown as RoutePoint, length = distance(a, b)
    if (length) { pieces.push({ start: total, length, point: fraction => fraction === 0 ? a : fraction === 1 ? b : a.map((value, axis) => value + (b[axis]! - value) * fraction) as unknown as RoutePoint, sagitta: () => 0 }); total += length }
    if (trims[i + 1]! > 0) {
      const arc = physicalFilletArc(points[i]!, points[i + 1]!, points[i + 2]!, bendRadius, trims[i + 1]!, joints[i], joints[i + 1]), length = arc.angle * bendRadius
      pieces.push({ start: total, length, point: arc.point, sagitta: span => 2 * bendRadius * Math.sin(arc.angle * span / 4) ** 2 }); total += length
    }
  }
  const diameter = 2 * tubeRadius, local = Math.PI * tubeRadius, closed = same(points[0]!, points.at(-1)!)
  for (let first = 0; first < pieces.length; first++) for (let second = first + 1; second < pieces.length; second++) {
    const stack: Array<readonly [Interval, Interval]> = [[{ piece: pieces[first]!, low: 0, high: 1 }, { piece: pieces[second]!, low: 0, high: 1 }]]
    while (stack.length) {
      const [a, b] = stack.pop()!, domain = separation(a, b, total, closed)
      if (domain.high <= local) continue
      const boxA = bounds(a), boxB = bounds(b), lower = Math.hypot(...boxA.min.map((value, axis) => Math.max(0, value - boxB.max[axis]!, boxB.min[axis]! - boxA.max[axis]!)))
      // Two endpoint roundoff bounds on each side plus the three-axis distance
      // evaluation delimit a floating-point boundary tie. As for obstacle
      // reservations, touching is allowed; this is not a metric clearance bias.
      if (enough(lower, diameter, 4 * Math.max(1, ...boxA.min.map(Math.abs), ...boxA.max.map(Math.abs), ...boxB.min.map(Math.abs), ...boxB.max.map(Math.abs)))) continue
      const midA = (a.low + a.high) / 2, midB = (b.low + b.high) / 2, p = a.piece.point(midA), q = b.piece.point(midB)
      const along = Math.abs(a.piece.start + midA * a.piece.length - b.piece.start - midB * b.piece.length), apart = closed ? Math.min(along, total - along) : along
      if (apart >= local && distance(p, q) + roundoff(p, q) < diameter) throw Error(`Accepted route intersects its own nonlocal tube reservation: ${id}`)
      const splitA = (a.high - a.low) * a.piece.length >= (b.high - b.low) * b.piece.length, interval = splitA ? a : b, middle = splitA ? midA : midB
      if (middle === interval.low || middle === interval.high) throw Error(`Self-clearance cannot be resolved at source floating precision: ${id}`)
      const left = { ...interval, high: middle }, right = { ...interval, low: middle }
      if (splitA) { stack.push([left, b], [right, b]) } else { stack.push([a, left], [a, right]) }
    }
  }
}
