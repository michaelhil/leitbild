import type { PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import { rayBoxCoordinates, type Vector3 } from './math.ts'

/** Packed transferable hierarchy: ray SAH and atomic overlap leaves, without a feature/object admission cap. */
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
  // Sort immutable centroid keys, not a left-associated chain of additions and
  // subtractions. That chain can compare a box against itself as nonzero after
  // rounding, violating the comparator ordering required by Array.sort.
  const centroids = new Float64Array(values.length * 3)
  values.forEach((box, id) => { for (let axis = 0; axis < 3; axis++) centroids[id * 3 + axis] = box.min[axis]! * .5 + box.max[axis]! * .5 })
  const build = (ids: number[], bounds = union(values,ids)): number => {
    const index = nodes.length, node = { bounds, left: -1, right: -1, first: 0, count: 0 }; nodes.push(node)
    const parentArea = area(bounds)
    if (ids.length > 1 && parentArea > 0) {
      const spans = bounds.max.map((value, axis) => value - bounds.min[axis]!), axis = spans.indexOf(Math.max(...spans))
      ids.sort((a, b) => centroids[a * 3 + axis]! - centroids[b * 3 + axis]! || a - b)
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
/** Centroid-midpoint overlap hierarchy uses exact primitive unions and atomic
 * leaves. It avoids presorting/ranking all three axes or searching split costs;
 * exact query predicates and caller source ordering remain unchanged. */
const createPhysicalOverlapSpatialIndex = (values:readonly PhysicalSceneBounds[]):PhysicalSpatialIndex=>{
 const count=values.length,nodeCount=count?count*2-1:0
 if(!Number.isSafeInteger(nodeCount)||nodeCount>2**31)throw Error('Centroid hierarchy exceeds its signed child-index address space')
 const bounds=new Float64Array(nodeCount*6),children=new Int32Array(nodeCount*2),ranges=new Uint32Array(nodeCount*2),order=Uint32Array.from(values,(_,id)=>id)
 children.fill(-1)
 const center=(id:number,axis:number)=>values[id]!.min[axis]!*.5+values[id]!.max[axis]!*.5
 const pending=count?[{node:0,first:0,end:count}]:[];let nextNode=1
 while(pending.length){
  const{node,first,end}=pending.pop()!,at=node*6,centroidMin=[Infinity,Infinity,Infinity],centroidMax=[-Infinity,-Infinity,-Infinity]
  bounds.fill(Infinity,at,at+3);bounds.fill(-Infinity,at+3,at+6)
  for(let i=first;i<end;i++)for(let axis=0;axis<3;axis++){
   const id=order[i]!,box=values[id]!,c=center(id,axis)
   bounds[at+axis]=Math.min(bounds[at+axis]!,box.min[axis]!);bounds[at+axis+3]=Math.max(bounds[at+axis+3]!,box.max[axis]!)
   centroidMin[axis]=Math.min(centroidMin[axis]!,c);centroidMax[axis]=Math.max(centroidMax[axis]!,c)
  }
  if(end-first===1){ranges[node*2]=first;ranges[node*2+1]=1;continue}
  let axis=0
  for(let a=1;a<3;a++)if(centroidMax[a]!-centroidMin[a]!>centroidMax[axis]!-centroidMin[axis]!)axis=a
  const midpoint=centroidMin[axis]!*.5+centroidMax[axis]!*.5
  let left=first,right=end-1
  while(left<=right){
   if(center(order[left]!,axis)<midpoint)left++
   else{const value=order[left]!;order[left]=order[right]!;order[right--]=value}
  }
  let split=left
  if(split===first||split===end){
   // Identical/adjacent representable centroids may not separate at their
   // midpoint. Numeric primitive-id order gives a deterministic median split.
   order.subarray(first,end).sort();split=first+Math.floor((end-first)/2)
  }
  const a=nextNode++,b=nextNode++;children[node*2]=a;children[node*2+1]=b
  pending.push({node:b,first:split,end},{node:a,first,end:split})
 }
 if(nextNode!==(count?nodeCount:1))throw Error('Centroid hierarchy did not construct all atomic leaves')
 return{bounds,children,ranges,order}
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

/** Self-collision traversal of an atomic overlap hierarchy. Every unordered
 * primitive pair is considered once; leaves use the original earlier/later
 * query orientation so floating-point boundary behavior stays identical. */
export const visitPhysicalAtomicOverlapPairs = (index: PhysicalSpatialIndex, visit: (earlier: number, later: number) => void): void => {
  if (!index.order.length) return
  if (index.bounds.length / 6 !== index.order.length * 2 - 1) throw Error('Self-pair traversal requires an atomic overlap hierarchy')
  const weights = new Float64Array(index.bounds.length / 6)
  for (let node = 0; node < weights.length; node++) {
    const at = node * 6, x = index.bounds[at + 3]! - index.bounds[at]!, y = index.bounds[at + 4]! - index.bounds[at + 1]!, z = index.bounds[at + 5]! - index.bounds[at + 2]!
    weights[node] = 2 * (x * y + y * z + z * x)
  }
  const overlap = (a: number, b: number, bothOrientations: boolean): boolean => {
    for (let axis = 0; axis < 3; axis++) {
      const aLow = index.bounds[a + axis]!, aHigh = index.bounds[a + axis + 3]!, bLow = index.bounds[b + axis]!, bHigh = index.bounds[b + axis + 3]!
      const error = Math.max(1, Math.abs(aLow), Math.abs(aHigh), Math.abs(bLow), Math.abs(bHigh)) * Number.EPSILON * 8
      if (bothOrientations) {
        // A parent pair may contain either source ordering. Reject only if
        // both numerical orientations exclude the separating interval.
        if (aHigh < bLow - error && bLow > aHigh + error || aLow > bHigh + error && bHigh < aLow - error) return false
      } else if (aHigh < bLow - error || aLow > bHigh + error) return false
    }
    return true
  }
  const pending = [0, 0]
  while (pending.length) {
    const b = pending.pop()!, a = pending.pop()!, leftA = index.children[a * 2]!, rightA = index.children[a * 2 + 1]!, leftB = index.children[b * 2]!, rightB = index.children[b * 2 + 1]!
    if (a === b) {
      if (leftA >= 0) pending.push(rightA, rightA, leftA, rightA, leftA, leftA)
      continue
    }
    if (!overlap(a * 6, b * 6, true)) continue
    if (leftA < 0 && leftB < 0) {
      if (index.ranges[a * 2 + 1] !== 1 || index.ranges[b * 2 + 1] !== 1) throw Error('Self-pair traversal requires an atomic overlap hierarchy')
      const idA = index.order[index.ranges[a * 2]!]!, idB = index.order[index.ranges[b * 2]!]!, earlier = Math.min(idA, idB), later = Math.max(idA, idB)
      const earlierNode = idA < idB ? a : b, laterNode = idA < idB ? b : a
      if (overlap(earlierNode * 6, laterNode * 6, false)) visit(earlier, later)
    } else if (leftB < 0 || leftA >= 0 && weights[a]! >= weights[b]!) pending.push(rightA, b, leftA, b)
    else pending.push(a, rightB, a, leftB)
  }
}
