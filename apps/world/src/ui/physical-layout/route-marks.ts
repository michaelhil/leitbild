import type { Vector3 } from '../map/physical-scene/math.ts'
import type { PhysicalProjectedPoint } from '../map/physical-scene/types.ts'
interface Region { readonly min: Vector3; readonly max: Vector3 }
type RoutePaths = ReadonlyArray<ReadonlyArray<Vector3>>
type Floor = { readonly low: number; readonly high: number }
const noRegions: ReadonlyArray<Region> = []
const sameRegions = (left: ReadonlyArray<Region>, right: ReadonlyArray<Region>): boolean => left === right || left.length === right.length && left.every((box, index) => box.min.every((value, axis) => value === right[index]!.min[axis]) && box.max.every((value, axis) => value === right[index]!.max[axis]))
// One current geometric selection per immutable source path, never all visited
// floors/scopes. Weak keys cannot retain an unloaded source/session.
const displayPaths = new WeakMap<ReadonlyArray<Vector3>, { readonly regions: ReadonlyArray<Region>; readonly low: number | undefined; readonly high: number | undefined; readonly paths: RoutePaths }>()

/** Clip the displayed centreline to the same spatial union and floor volume.
 * Closed interval endpoints retain truthful continuation positions. */
export const physicalRouteDisplayPaths = (points: ReadonlyArray<Vector3>, regions: ReadonlyArray<Region>, floor?: Floor): RoutePaths => {
  const previous = displayPaths.get(points)
  if (previous && previous.low === floor?.low && previous.high === floor?.high && sameRegions(previous.regions, regions)) return previous.paths
  const paths = clipRouteDisplayPaths(points, regions, floor)
  displayPaths.set(points, { regions, low: floor?.low, high: floor?.high, paths })
  return paths
}
const clipRouteDisplayPaths = (points: ReadonlyArray<Vector3>, regions: ReadonlyArray<Region>, floor?: Floor): RoutePaths => {
  if (points.length < 2) return []
  // With no inspection volume, every segment and authored duplicate point is
  // already the exact displayed path. Borrow it without copying its vertices.
  if (!regions.length && !floor) return [points]
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


interface RouteOccurrence {
  readonly spatialPath?: { readonly points: ReadonlyArray<Vector3> } | undefined
  readonly clipToScope?: boolean | undefined
  readonly levelId: string
  readonly inspectionLevels?: ReadonlyArray<Floor & { readonly levelId: string }> | undefined
}
export interface PhysicalRouteInspectionPath { readonly levelId: string | undefined; readonly points: ReadonlyArray<Vector3> }
const inspectionPaths = new WeakMap<RouteOccurrence, { readonly regions: ReadonlyArray<Region>; readonly levelId: string; readonly separated: boolean; readonly paths: ReadonlyArray<PhysicalRouteInspectionPath> }>()
/** All concurrently displayed floors form ONE current selection. Retain their
 * static clipping across camera, live-state and opacity changes; projection
 * still uses the actual current camera and separation magnitude. */
export const physicalRouteInspectionPaths = (occurrence: RouteOccurrence, regions: ReadonlyArray<Region>, view: { readonly levelId: string; readonly separation: number }): ReadonlyArray<PhysicalRouteInspectionPath> => {
  if (!occurrence.spatialPath) return []
  const selectedRegions = occurrence.clipToScope ? regions : noRegions, separated = view.levelId === 'all' && view.separation > 0
  const previous = inspectionPaths.get(occurrence)
  if (previous && previous.levelId === view.levelId && previous.separated === separated && sameRegions(previous.regions, selectedRegions)) return previous.paths
  const floors = separated && occurrence.inspectionLevels?.length ? occurrence.inspectionLevels.map(volume => ({ id: volume.levelId, volume })) : [{ id: view.levelId === 'all' ? undefined : view.levelId, volume: view.levelId === 'all' || occurrence.levelId === 'site' ? undefined : occurrence.inspectionLevels?.find(volume => volume.levelId === view.levelId) }]
  const paths = floors.flatMap(floor => physicalRouteDisplayPaths(occurrence.spatialPath!.points, selectedRegions, floor.volume).map(points => ({ levelId: floor.id, points })))
  inspectionPaths.set(occurrence, { regions: selectedRegions, levelId: view.levelId, separated, paths })
  return paths
}

/** Screen spacing is a legibility policy derived from the actual font size,
 * not an entity-count cutoff. Viewport clipping bounds off-screen work. */
export const createPhysicalRouteScreenMarks = (viewport: { readonly width: number; readonly height: number }, fontSize: number) => {
  if (!(fontSize > 0) || !Number.isFinite(fontSize)) throw Error('Flow marks need a finite positive display font size')
  const output: Array<{ point: { x: number; y: number }; angle: number }> = [], spacing = fontSize * 8
  let distance = 0, next = spacing / 2, hasPrevious = false, previousX = 0, previousY = 0, previousDepth = 0
  return {
    marks: output as ReadonlyArray<{ readonly point: { readonly x: number; readonly y: number }; readonly angle: number }>,
    add(x: number, y: number, depth: number): void {
      const ax = previousX, ay = previousY, az = previousDepth, first = !hasPrevious
      previousX = x; previousY = y; previousDepth = depth; hasPrevious = true
      if (first || !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(az) || !Number.isFinite(depth) || az < -1 && depth < -1 || az > 1 && depth > 1) return
      const dx = x - ax, dy = y - ay, length = Math.hypot(dx, dy)
      if (length === 0) return
      let low = 0, high = 1
      for (let axis = 0; axis < 2; axis++) {
        const start = axis === 0 ? ax : ay, delta = axis === 0 ? dx : dy, limit = axis === 0 ? viewport.width : viewport.height
        if (delta === 0) { if (start < 0 || start > limit) { high = -1; break } }
        else { const first = -start / delta, last = (limit - start) / delta; low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last)) }
      }
      if (high > low) {
        let at = Math.max(next, Math.ceil((distance + low * length - spacing / 2) / spacing) * spacing + spacing / 2)
        while (at <= distance + high * length) { const part = (at - distance) / length; output.push({ point: { x: ax + dx * part, y: ay + dy * part }, angle: Math.atan2(dy, dx) }); at += spacing }
        next = at
      }
      distance += length
    },
  }
}

/** Array input remains useful for independent geometric tests. Live drawing
 * feeds the same accumulator directly from the projection visitor. */
export const physicalRouteScreenMarks = (points: ReadonlyArray<PhysicalProjectedPoint>, viewport: { readonly width: number; readonly height: number }, fontSize: number): ReadonlyArray<{ readonly point: { readonly x: number; readonly y: number }; readonly angle: number }> => {
  const result = createPhysicalRouteScreenMarks(viewport, fontSize)
  for (const point of points) result.add(point.x, point.y, point.depth)
  return result.marks
}
