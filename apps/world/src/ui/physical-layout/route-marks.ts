import type { Vector3 } from '../map/physical-scene/math.ts'
import type { PhysicalProjectedPoint } from '../map/physical-scene/types.ts'
interface Region { readonly min: Vector3; readonly max: Vector3 }

/** Clip the displayed centreline to the same spatial union and floor volume.
 * Closed interval endpoints retain truthful continuation positions. */
export const physicalRouteDisplayPaths = (points: ReadonlyArray<Vector3>, regions: ReadonlyArray<Region>, floor?: { readonly low: number; readonly high: number }): ReadonlyArray<ReadonlyArray<Vector3>> => {
  const boxes = regions.length ? regions : [{ min: [-Infinity, -Infinity, -Infinity] as const, max: [Infinity, Infinity, Infinity] as const }]
  const paths: Vector3[][] = []
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!, intervals: Array<[number, number]> = []
    for (const box of boxes) {
      let low = 0, high = 1
      for (let axis = 0; axis < 3; axis++) {
        const min = axis === 2 && floor ? Math.max(box.min[axis]!, floor.low) : box.min[axis]!, max = axis === 2 && floor ? Math.min(box.max[axis]!, floor.high) : box.max[axis]!
        if (max < min) { high = -1; break }
        const delta = b[axis]! - a[axis]!
        if (delta === 0) { if (a[axis]! < min || a[axis]! > max) { high = -1; break } }
        else { const left = (min - a[axis]!) / delta, right = (max - a[axis]!) / delta; low = Math.max(low, Math.min(left, right)); high = Math.min(high, Math.max(left, right)) }
      }
      if (high > low) intervals.push([low, high])
    }
    intervals.sort((left, right) => left[0] - right[0])
    const joined: Array<[number, number]> = []
    for (const interval of intervals) { const previous = joined.at(-1); if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]); else joined.push([...interval]) }
    const at = (fraction: number): Vector3 => a.map((value, axis) => fraction === 0 ? value : fraction === 1 ? b[axis]! : value + (b[axis]! - value) * fraction) as unknown as Vector3
    for (const [low, high] of joined) {
      const start = at(low), end = at(high), previous = paths.at(-1)
      if (previous?.at(-1)?.every((value, axis) => value === start[axis])) previous.push(end)
      else paths.push([start, end])
    }
  }
  return paths
}

/** Screen spacing is a legibility policy derived from the actual font size,
 * not an entity-count cutoff. Viewport clipping bounds off-screen work. */
export const physicalRouteScreenMarks = (points: ReadonlyArray<PhysicalProjectedPoint>, viewport: { readonly width: number; readonly height: number }, fontSize: number): ReadonlyArray<{ readonly point: { readonly x: number; readonly y: number }; readonly angle: number }> => {
  if (!(fontSize > 0) || !Number.isFinite(fontSize)) throw Error('Flow marks need a finite positive display font size')
  const output: Array<{ point: { x: number; y: number }; angle: number }> = [], spacing = fontSize * 8
  let distance = 0, next = spacing / 2
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!
    if (![a.x, a.y, b.x, b.y, a.depth, b.depth].every(Number.isFinite) || a.depth < -1 && b.depth < -1 || a.depth > 1 && b.depth > 1) continue
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy)
    if (length === 0) continue
    let low = 0, high = 1
    for (const [start, delta, limit] of [[a.x, dx, viewport.width], [a.y, dy, viewport.height]]) {
      if (delta === 0) { if (start! < 0 || start! > limit!) { high = -1; break } }
      else { const first = -start! / delta!, last = (limit! - start!) / delta!; low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last)) }
    }
    if (high > low) {
      let at = Math.max(next, Math.ceil((distance + low * length - spacing / 2) / spacing) * spacing + spacing / 2)
      while (at <= distance + high * length) { const part = (at - distance) / length; output.push({ point: { x: a.x + dx * part, y: a.y + dy * part }, angle: Math.atan2(dy, dx) }); at += spacing }
      next = at
    }
    distance += length
  }
  return output
}
