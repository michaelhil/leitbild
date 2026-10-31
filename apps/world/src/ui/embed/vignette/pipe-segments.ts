import { CORNER_RADIUS, OVERLAP_HALF_GAP, type PipeSize, type PipeValue, type Segment } from '@oicl/connector-diagram'

// A routed pipe as OpenBridge connector-diagram segments: straight runs with
// OpenBridge's rounded corners (tighter where a jog is shorter than two of
// them), a clean gap where another run crosses over, a flow chevron only where
// the model computes the direction, on a run long enough to carry it and clear
// of the drawing's text and symbols, and a cap where the drawing stops, on a
// straight of its own (owner finding 4, U-18). Pure, so the geometry is tested
// without a DOM.

type Point = readonly [number, number]
type Direction = 'top' | 'right' | 'bottom' | 'left'
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** How a pipe's flow reads: in its direction or against it, flowing in a direction not known, none, or not known; a power line live or dead. */
export type PipeLook = 'forward' | 'reverse' | 'flowing' | 'none' | 'unknown' | 'live' | 'dead'

/** Hollow below the no-flow band, dashed when unknown; never `closed`, which would read as a shut pipe. */
export const pipeValue = (look: PipeLook): PipeValue =>
  look === 'none' || look === 'dead' ? 'empty' : look === 'unknown' ? 'closed-dash' : 'open-flow'

const directionOf = (from: Point, to: Point): Direction =>
  to[0] > from[0] ? 'right' : to[0] < from[0] ? 'left' : to[1] > from[1] ? 'bottom' : 'top'

const opposite: Readonly<Record<Direction, Direction>> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

const base = (id: string, value: PipeValue, size: PipeSize) => ({ connectionId: id, value, size })

/** The least straight a pipe ends on where the drawing stops: its cap or arrow never sits in a bend. */
export const STUB_STRAIGHT = 16

const lengthOf = (from: Point, to: Point): number => Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1])

/**
 * Straights and radius-8 corners along an orthogonal polyline, split where another run crosses it. A corner takes the
 * radius its legs leave it: a jog shorter than two radii shares its length between its two corners, so no corner
 * overruns the next.
 */
export const pipeSegments = (id: string, points: ReadonlyArray<Point>, gaps: ReadonlyArray<Point>, value: PipeValue, size: PipeSize): Segment[] => {
  const segments: Segment[] = []
  const legs = points.slice(1).map((point, at) => lengthOf(points[at]!, point))
  // What a leg gives each corner at its ends: all of it at the polyline's ends, half of it between two corners.
  const share = (leg: number): number => (leg === 0 || leg === legs.length - 1 ? legs[leg]! : legs[leg]! / 2)
  let start = { x: points[0]![0], y: points[0]![1] }
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1]!
    const [bx, by] = points[index]!
    const last = index === points.length - 1
    const radius = last ? 0 : Math.min(CORNER_RADIUS, share(index - 1), share(index))
    const step = { x: Math.sign(bx - ax), y: Math.sign(by - ay) }
    const end = { x: bx - step.x * radius, y: by - step.y * radius }
    if (end.x !== start.x || end.y !== start.y) segments.push(...splitAtGaps({ kind: 'straight', ...base(id, value, size), x1: start.x, y1: start.y, x2: end.x, y2: end.y }, gaps, size))
    if (!last) {
      const [cx, cy] = points[index + 1]!
      const to = { x: bx + Math.sign(cx - bx) * radius, y: by + Math.sign(cy - by) * radius }
      // The elbow is the corner of the square spanned by the two tangent points.
      const top = by === Math.min(end.y, to.y)
      const left = bx === Math.min(end.x, to.x)
      if (radius > 0) segments.push({ kind: 'corner', ...base(id, value, size), from: end, to, direction: `${top ? 'Top' : 'Bottom'}${left ? 'Left' : 'Right'}` })
      start = to
    }
  }
  return segments
}

const splitAtGaps = (straight: Extract<Segment, { kind: 'straight' }>, gaps: ReadonlyArray<Point>, size: PipeSize): Segment[] => {
  const half = OVERLAP_HALF_GAP[size]
  const vertical = straight.x1 === straight.x2
  const from = vertical ? straight.y1 : straight.x1
  const to = vertical ? straight.y2 : straight.x2
  const sign = Math.sign(to - from)
  const cuts = gaps
    .filter(point => (vertical ? point[0] === straight.x1 : point[1] === straight.y1))
    .map(point => vertical ? point[1] : point[0])
    .filter(at => (at - from) * sign > 0 && (to - at) * sign > 0)
    .sort((left, right) => (left - right) * sign)
  if (cuts.length === 0) return [straight]
  // Pieces in flow direction, each stopping half a gap short of a crossing.
  const edges = [from, ...cuts.flatMap(cut => [cut - sign * half, cut + sign * half]), to]
  return Array.from({ length: edges.length / 2 }, (_, at) => [edges[at * 2]!, edges[at * 2 + 1]!] as const)
    .filter(([start, end]) => (end - start) * sign > 0)
    .map(([start, end]) => vertical ? { ...straight, y1: start, y2: end } : { ...straight, x1: start, x2: end })
}

/**
 * A pipe that stops at its `end` ('first' or 'last' point) as drawn: a last leg too short to end on a straight of
 * STUB_STRAIGHT after its bend runs on into the stop's own cell (`room`, the box the layout gave the stop), so its cap
 * stands by the stop's label; where the cell does not hold that much, the leg and its bend go, and the pipe ends where
 * it turned, straight on. An explicitly required straight also reserves room for a declared flow chevron inside a
 * stop's existing cell, including a two-point route. That reservation never extends beyond the cell, shrinks the
 * glyph or removes an already valid bend when the extra room is unavailable.
 */
export const endStraight = (points: ReadonlyArray<Point>, end: 'first' | 'last', room?: Box, requiredStraight?: number): ReadonlyArray<Point> => {
  const ordered = end === 'last' ? [...points] : [...points].reverse()
  const need = (requiredStraight ?? STUB_STRAIGHT) + (ordered.length > 2 ? CORNER_RADIUS : 0)
  if ((ordered.length > 2 || requiredStraight !== undefined) && room !== undefined) {
    const [from, to] = [ordered.at(-2)!, ordered.at(-1)!]
    const step = [Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])] as const
    const short = need - lengthOf(from, to)
    const far = step[0] > 0 ? room.x + room.width - to[0] : step[0] < 0 ? to[0] - room.x : step[1] > 0 ? room.y + room.height - to[1] : to[1] - room.y
    // Endpoint matching permits a pixel of drawing tolerance. Reserving new
    // space requires actual cell membership, including the perpendicular axis.
    const belongs = requiredStraight === undefined || to[0] >= room.x && to[0] <= room.x + room.width && to[1] >= room.y && to[1] <= room.y + room.height
    if (belongs && short > 0 && far >= short) ordered[ordered.length - 1] = [to[0] + step[0] * short, to[1] + step[1] * short]
  }
  while (requiredStraight === undefined && ordered.length > 2 && lengthOf(ordered.at(-2)!, ordered.at(-1)!) < need) ordered.pop()
  return end === 'last' ? ordered : ordered.reverse()
}

/** The least straight piece a chevron stands on, and how far it keeps from text and symbols. */
export const CHEVRON_PIECE = 48
const CHEVRON_CLEAR = 10

/**
 * One chevron in flow direction on the longest straight piece clear of bends (a corner radius) and crossing gaps that
 * is at least CHEVRON_PIECE long, in its middle, or a third along where the middle comes within CHEVRON_CLEAR of a
 * box to `avoid` (the drawing's text and symbols); none where no piece holds one clear, so no arrowhead stands loose
 * beside a name or against a symbol.
 */
export const chevronSegment = (id: string, points: ReadonlyArray<Point>, gaps: ReadonlyArray<Point>, value: PipeValue, size: PipeSize, reverse: boolean, avoid: ReadonlyArray<Box> = []): Segment | null => {
  const pieces = pipeSegments(id, points, gaps, value, size)
    .filter((segment): segment is Extract<Segment, { kind: 'straight' }> => segment.kind === 'straight')
    .map(segment => ({ segment, length: Math.abs(segment.x2 - segment.x1) + Math.abs(segment.y2 - segment.y1) }))
    .filter(piece => piece.length >= CHEVRON_PIECE)
    .sort((left, right) => right.length - left.length)
  const clear = (x: number, y: number): boolean => avoid.every(box => x < box.x - CHEVRON_CLEAR || x > box.x + box.width + CHEVRON_CLEAR || y < box.y - CHEVRON_CLEAR || y > box.y + box.height + CHEVRON_CLEAR)
  for (const { segment: { x1, y1, x2, y2 } } of pieces) {
    const at = [1 / 2, 1 / 3, 2 / 3].map(share => ({ x: x1 + (x2 - x1) * share, y: y1 + (y2 - y1) * share })).find(point => clear(point.x, point.y))
    if (at === undefined) continue
    const forward = directionOf([x1, y1], [x2, y2])
    return { kind: 'direction', ...base(id, value, size), x: at.x, y: at.y, direction: reverse ? opposite[forward] : forward }
  }
  return null
}

/**
 * Where a pipe leaves the drawing: OpenBridge's end cap, facing out along its last straight. Its flow reads from the
 * chevron on the pipe and the stop's "to" or "from", so no arrowhead hangs at its end.
 */
export const stubEndSegment = (id: string, points: ReadonlyArray<Point>, direction: 'in' | 'out', value: PipeValue, size: PipeSize): Segment => {
  const end = direction === 'out' ? points.at(-1)! : points[0]!
  const neighbour = direction === 'out' ? points.at(-2)! : points[1]!
  return { kind: 'endpoint', ...base(id, value, size), x: end[0], y: end[1], direction: directionOf(neighbour, end) }
}
