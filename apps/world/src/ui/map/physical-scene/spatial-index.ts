import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { rayBoxCoordinates, type Vector3 } from './math.ts'

/** Packed transferable hierarchy; SAH determines leaves, never a feature/object admission cap. */
export interface PhysicalSpatialIndex { readonly bounds: Float64Array; readonly children: Int32Array; readonly ranges: Uint32Array; readonly order: Uint32Array }
const area = (b: PhysicalSceneBounds): number => { const x = b.max[0] - b.min[0], y = b.max[1] - b.min[1], z = b.max[2] - b.min[2]; return 2 * (x * y + y * z + z * x) }
const union = (values: ReadonlyArray<PhysicalSceneBounds>, ids: ArrayLike<number>, first = 0, end = ids.length): PhysicalSceneBounds => {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let at = first; at < end; at++) for (let axis = 0; axis < 3; axis++) { const id = ids[at]!; min[axis] = Math.min(min[axis]!, values[id]!.min[axis]!); max[axis] = Math.max(max[axis]!, values[id]!.max[axis]!) }
  return { min, max }
}
export const createPhysicalSpatialIndex = (values: ReadonlyArray<PhysicalSceneBounds>, query: 'ray' | 'overlap' = 'ray'): PhysicalSpatialIndex => {
  if (query === 'overlap') return createPhysicalOverlapSpatialIndex(values)
  const nodes: Array<{ bounds: PhysicalSceneBounds; left: number; right: number; first: number; count: number }> = [], order: number[] = []
  const build = (ids: number[], bounds = union(values,ids)): number => {
    const index = nodes.length, node = { bounds, left: -1, right: -1, first: 0, count: 0 }; nodes.push(node)
    const parentArea = area(bounds)
    if (ids.length > 1 && parentArea > 0) {
      const spans = bounds.max.map((value, axis) => value - bounds.min[axis]!), axis = spans.indexOf(Math.max(...spans))
      ids.sort((a, b) => values[a]!.min[axis]! + values[a]!.max[axis]! - values[b]!.min[axis]! - values[b]!.max[axis]! || a - b)
      const middle = Math.floor(ids.length / 2), left = ids.slice(0, middle), right = ids.slice(middle), leftBounds=union(values,left), rightBounds=union(values,right)
      // Standard SAH normalized to a primitive test: one traversal plus expected
      // child tests. The unit cost is not a maximum leaf or candidate count.
      const splitCost = 1 + (area(leftBounds) * left.length + area(rightBounds) * right.length) / parentArea
      // These exact bounds already paid for the SAH decision also belong to
      // the children; do not rescan their primitives on recursive entry.
      if (splitCost < ids.length) { node.left = build(left,leftBounds); node.right = build(right,rightBounds); return index }
    }
    node.first = order.length; node.count = ids.length; order.push(...ids.sort((a, b) => a - b)); return index
  }
  if (values.length) build(values.map((_, index) => index))
  return { bounds: Float64Array.from(nodes.flatMap(node => [...node.bounds.min, ...node.bounds.max])), children: Int32Array.from(nodes.flatMap(node => [node.left, node.right])), ranges: Uint32Array.from(nodes.flatMap(node => [node.first, node.count])), order: Uint32Array.from(order) }
}
const createPhysicalOverlapSpatialIndex = (values: ReadonlyArray<PhysicalSceneBounds>): PhysicalSpatialIndex => {
  const nodes: Array<{ bounds: PhysicalSceneBounds; left: number; right: number; first: number; count: number }> = [], order: number[] = []
  // Presort once and partition disjoint ranges in typed storage. Long parallel
  // routes share their largest geometric span, so SAH must consider transverse
  // axes too. No recursive sorting, Set membership or child id-array copies.
  const sorted = [0, 1, 2].map(axis => Uint32Array.from(values.map((_, id) => id).sort((a, b) => values[a]!.min[axis]! + values[a]!.max[axis]! - values[b]!.min[axis]! - values[b]!.max[axis]! || a - b)))
  const rank = sorted.map(ids => { const result = new Uint32Array(values.length); ids.forEach((id, at) => { result[id] = at }); return result }), scratch = new Uint32Array(values.length)
  const build = (first: number, end: number, bounds = union(values, sorted[0]!, first, end)): number => {
    const count = end - first, index = nodes.length, node = { bounds, left: -1, right: -1, first: 0, count: 0 }; nodes.push(node)
    const parentArea = area(bounds)
    if (count > 1 && parentArea > 0) {
      const middle = first + Math.floor(count / 2), leftCount = middle - first
      let best: { axis: number; cost: number; left: PhysicalSceneBounds; right: PhysicalSceneBounds } | undefined
      for (let axis = 0; axis < 3; axis++) {
        const left = union(values, sorted[axis]!, first, middle), right = union(values, sorted[axis]!, middle, end)
        const cost = 1 + (area(left) * leftCount + area(right) * (count - leftCount)) / parentArea
        if (!best || cost < best.cost) best = { axis, cost, left, right }
      }
      if (best!.cost < count) {
        const ranks = rank[best!.axis]!, pivot = ranks[sorted[best!.axis]![middle]!]!
        for (let axis = 0; axis < 3; axis++) {
          const ids = sorted[axis]!; let left = first, right = middle
          for (let at = first; at < end; at++) { const id = ids[at]!; scratch[ranks[id]! < pivot ? left++ : right++] = id }
          ids.set(scratch.subarray(first, end), first)
        }
        node.left = build(first, middle, best!.left); node.right = build(middle, end, best!.right); return index
      }
    }
    node.first = order.length; node.count = count; order.push(...Array.from(sorted[0]!.subarray(first, end)).sort((a, b) => a - b)); return index
  }
  if (values.length) build(0, values.length)
  return { bounds: Float64Array.from(nodes.flatMap(node => [...node.bounds.min, ...node.bounds.max])), children: Int32Array.from(nodes.flatMap(node => [node.left, node.right])), ranges: Uint32Array.from(nodes.flatMap(node => [node.first, node.count])), order: Uint32Array.from(order) }
}
export const physicalSpatialBytes = (index: PhysicalSpatialIndex): number => index.bounds.byteLength + index.children.byteLength + index.ranges.byteLength + index.order.byteLength
const distanceToNode = (index: PhysicalSpatialIndex, node: number, origin: Vector3, direction: Vector3): number | null => {
  const at = node * 6, minX = index.bounds[at]!, minY = index.bounds[at + 1]!, minZ = index.bounds[at + 2]!, maxX = index.bounds[at + 3]!, maxY = index.bounds[at + 4]!, maxZ = index.bounds[at + 5]!
  const magnitude = Math.max(1, Math.abs(minX), Math.abs(minY), Math.abs(minZ), Math.abs(maxX), Math.abs(maxY), Math.abs(maxZ)), margin = magnitude * Number.EPSILON * 8
  return rayBoxCoordinates(origin, direction, minX - margin, minY - margin, minZ - margin, maxX + margin, maxY + margin, maxZ + margin)
}
export const visitPhysicalSpatialRay = (index: PhysicalSpatialIndex, origin: Vector3, direction: Vector3, nearest: () => number, visit: (primitive: number) => void): void => {
  if (!index.order.length) return
  // The immutable child distance already paid for sibling ordering remains
  // exact when that node is popped. Re-evaluate only the caller's nearest bound.
  const pending = [0], distances = [distanceToNode(index, 0, origin, direction)]
  while (pending.length) {
    const node = pending.pop()!, distance = distances.pop() as number | null
    if (distance === null || distance > nearest()) continue
    const left = index.children[node * 2]!, right = index.children[node * 2 + 1]!
    if (left < 0) { const first = index.ranges[node * 2]!, count = index.ranges[node * 2 + 1]!; for (let offset = first; offset < first + count; offset++) visit(index.order[offset]!) }
    else {
      const a = distanceToNode(index, left, origin, direction), b = distanceToNode(index, right, origin, direction)
      if (a === null) { if (b !== null) { pending.push(right); distances.push(b) } }
      else if (b === null) { pending.push(left); distances.push(a) }
      else if (a <= b) { pending.push(right, left); distances.push(b, a) }
      else { pending.push(left, right); distances.push(a, b) }
    }
  }
}

/** Conservative pair eligibility, independent of hierarchy leaf grouping.
 * Bounds are actual triangle coordinates; the same forward-error reservation
 * as node traversal permits arithmetic boundary ties without a metric epsilon. */
export const physicalSpatialBoundsOverlap = (a: PhysicalSceneBounds, b: PhysicalSceneBounds): boolean => {
  for (let axis = 0; axis < 3; axis++) {
    const low = a.min[axis]!, high = a.max[axis]!, scale = Math.max(1, Math.abs(low), Math.abs(high), Math.abs(b.min[axis]!), Math.abs(b.max[axis]!)), error = scale * Number.EPSILON * 8
    if (high < b.min[axis]! - error || low > b.max[axis]! + error) return false
  }
  return true
}

/** Conservative overlap query used during immutable surface preparation. */
export const visitPhysicalSpatialBounds = (index: PhysicalSpatialIndex, bounds: PhysicalSceneBounds, visit: (primitive: number) => void): void => {
  if (!index.order.length) return
  const pending = [0]
  while (pending.length) {
    const node = pending.pop()!, at = node * 6
    let overlaps = true
    for (let axis = 0; axis < 3; axis++) {
      const low = index.bounds[at + axis]!, high = index.bounds[at + axis + 3]!, scale = Math.max(1, Math.abs(low), Math.abs(high), Math.abs(bounds.min[axis]!), Math.abs(bounds.max[axis]!))
      const error = scale * Number.EPSILON * 8
      if (high < bounds.min[axis]! - error || low > bounds.max[axis]! + error) { overlaps = false; break }
    }
    if (!overlaps) continue
    const left = index.children[node * 2]!, right = index.children[node * 2 + 1]!
    if (left < 0) { const first = index.ranges[node * 2]!, count = index.ranges[node * 2 + 1]!; for (let offset = first; offset < first + count; offset++) visit(index.order[offset]!) }
    else pending.push(right, left)
  }
}
