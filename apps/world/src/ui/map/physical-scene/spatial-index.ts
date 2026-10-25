import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { rayBox, type Vector3 } from './math.ts'

/** Packed transferable hierarchy; SAH determines leaves, never a feature/object admission cap. */
export interface PhysicalSpatialIndex { readonly bounds: Float64Array; readonly children: Int32Array; readonly ranges: Uint32Array; readonly order: Uint32Array }
const area = (b: PhysicalSceneBounds): number => { const x = b.max[0] - b.min[0], y = b.max[1] - b.min[1], z = b.max[2] - b.min[2]; return 2 * (x * y + y * z + z * x) }
const union = (values: ReadonlyArray<PhysicalSceneBounds>, ids: ReadonlyArray<number>): PhysicalSceneBounds => {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const id of ids) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, values[id]!.min[axis]!); max[axis] = Math.max(max[axis]!, values[id]!.max[axis]!) }
  return { min, max }
}
export const createPhysicalSpatialIndex = (values: ReadonlyArray<PhysicalSceneBounds>): PhysicalSpatialIndex => {
  const nodes: Array<{ bounds: PhysicalSceneBounds; left: number; right: number; first: number; count: number }> = [], order: number[] = []
  const build = (ids: number[]): number => {
    const bounds = union(values, ids), index = nodes.length, node = { bounds, left: -1, right: -1, first: 0, count: 0 }; nodes.push(node)
    const parentArea = area(bounds)
    if (ids.length > 1 && parentArea > 0) {
      const spans = bounds.max.map((value, axis) => value - bounds.min[axis]!), axis = spans.indexOf(Math.max(...spans))
      ids.sort((a, b) => values[a]!.min[axis]! + values[a]!.max[axis]! - values[b]!.min[axis]! - values[b]!.max[axis]! || a - b)
      const middle = Math.floor(ids.length / 2), left = ids.slice(0, middle), right = ids.slice(middle)
      // Standard SAH normalized to a primitive test: one traversal plus expected
      // child tests. The unit cost is not a maximum leaf or candidate count.
      const splitCost = 1 + (area(union(values, left)) * left.length + area(union(values, right)) * right.length) / parentArea
      if (splitCost < ids.length) { node.left = build(left); node.right = build(right); return index }
    }
    node.first = order.length; node.count = ids.length; order.push(...ids.sort((a, b) => a - b)); return index
  }
  if (values.length) build(values.map((_, index) => index))
  return { bounds: Float64Array.from(nodes.flatMap(node => [...node.bounds.min, ...node.bounds.max])), children: Int32Array.from(nodes.flatMap(node => [node.left, node.right])), ranges: Uint32Array.from(nodes.flatMap(node => [node.first, node.count])), order: Uint32Array.from(order) }
}
export const physicalSpatialBytes = (index: PhysicalSpatialIndex): number => index.bounds.byteLength + index.children.byteLength + index.ranges.byteLength + index.order.byteLength
const distanceToNode = (index: PhysicalSpatialIndex, node: number, origin: Vector3, direction: Vector3): number | null => {
  const at = node * 6, min = index.bounds.subarray(at, at + 3), max = index.bounds.subarray(at + 3, at + 6), magnitude = Math.max(1, ...min.map(Math.abs), ...max.map(Math.abs)), margin = magnitude * Number.EPSILON * 8
  return rayBox(origin, direction, { min: [min[0]! - margin, min[1]! - margin, min[2]! - margin], max: [max[0]! + margin, max[1]! + margin, max[2]! + margin] })
}
export const visitPhysicalSpatialRay = (index: PhysicalSpatialIndex, origin: Vector3, direction: Vector3, nearest: () => number, visit: (primitive: number) => void): void => {
  if (!index.order.length) return
  const pending = [0]
  while (pending.length) {
    const node = pending.pop()!, distance = distanceToNode(index, node, origin, direction)
    if (distance === null || distance > nearest()) continue
    const left = index.children[node * 2]!, right = index.children[node * 2 + 1]!
    if (left < 0) { const first = index.ranges[node * 2]!, count = index.ranges[node * 2 + 1]!; for (let offset = first; offset < first + count; offset++) visit(index.order[offset]!) }
    else {
      const a = distanceToNode(index, left, origin, direction), b = distanceToNode(index, right, origin, direction)
      if (a === null) { if (b !== null) pending.push(right) }
      else if (b === null) pending.push(left)
      else if (a <= b) pending.push(right, left)
      else pending.push(left, right)
    }
  }
}
