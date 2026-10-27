import type { PackPhysicalScene, PhysicalSceneBounds } from '../../../core/packs/scene.ts'

/** Inspection areas retain their members' spatial union. Filling the enclosing
 * AABB would silently include neighbouring rooms between disjoint members. */
export const physicalScopeRegions = (scene: Pick<PackPhysicalScene, 'scopes'>, scopeId?: string): ReadonlyArray<PhysicalSceneBounds> => {
  if (!scopeId) return []
  const scopes = new Map((scene.scopes ?? []).map(scope => [scope.id, scope])), selected = scopes.get(scopeId)
  if (!selected) throw Error(`Unknown physical inspection scope: ${scopeId}`)
  const members = selected.kind === 'area' ? selected.members!.map(id => scopes.get(id)!) : [selected]
  if (members.some(scope => !scope)) throw Error(`Physical inspection area has an unresolved member: ${scopeId}`)
  const unique = new Map(members.map(scope => [JSON.stringify(scope.bounds), scope.bounds]))
  return [...unique.values()]
}
const subtract = (source: PhysicalSceneBounds, other: PhysicalSceneBounds): PhysicalSceneBounds[] => {
  const low = source.min.map((value, axis) => Math.max(value, other.min[axis]!)), high = source.max.map((value, axis) => Math.min(value, other.max[axis]!))
  if (low.some((value, axis) => value >= high[axis]!)) return [source]
  const min = [...source.min], max = [...source.max], result: PhysicalSceneBounds[] = []
  for (let axis = 0; axis < 3; axis++) {
    if (min[axis]! < low[axis]!) { const end = [...max]; end[axis] = low[axis]!; result.push({ min: [...min] as [number, number, number], max: end as [number, number, number] }); min[axis] = low[axis]! }
    if (max[axis]! > high[axis]!) { const begin = [...min]; begin[axis] = high[axis]!; result.push({ min: begin as [number, number, number], max: [...max] as [number, number, number] }); max[axis] = high[axis]! }
  }
  return result
}
/** Exact box partition for drawing, not a spatial source mutation. */
export const disjointPhysicalScopeRegions = (regions: ReadonlyArray<PhysicalSceneBounds>): ReadonlyArray<PhysicalSceneBounds> => {
  const result: PhysicalSceneBounds[] = []
  for (const region of regions) {
    if (region.min.some((value, axis) => value >= region.max[axis]!)) throw Error('Scoped 3D route inspection requires positive spatial volume')
    let remaining = [region]
    for (const previous of result) remaining = remaining.flatMap(piece => subtract(piece, previous))
    result.push(...remaining)
  }
  return result
}
export interface PhysicalScopeFace {
  readonly axis: number; readonly coordinate: number; readonly outward: -1 | 1
  readonly axes: readonly [number, number]
  readonly min: readonly [number, number]; readonly max: readonly [number, number]
}
const subtractRectangle = (face: PhysicalScopeFace, other: PhysicalSceneBounds): PhysicalScopeFace[] => {
  const low = face.min.map((value, index) => Math.max(value, other.min[face.axes[index]!]!)), high = face.max.map((value, index) => Math.min(value, other.max[face.axes[index]!]!))
  if (low.some((value, index) => value >= high[index]!)) return [face]
  const min = [...face.min], max = [...face.max], result: PhysicalScopeFace[] = []
  for (let axis = 0; axis < 2; axis++) {
    if (min[axis]! < low[axis]!) { const end = [...max]; end[axis] = low[axis]!; result.push({ ...face, min: [...min] as [number, number], max: end as [number, number] }); min[axis] = low[axis]! }
    if (max[axis]! > high[axis]!) { const begin = [...min]; begin[axis] = high[axis]!; result.push({ ...face, min: begin as [number, number], max: [...max] as [number, number] }); max[axis] = high[axis]! }
  }
  return result
}
/** External faces only. Shared partition faces must never cap a continuous pipe. */
export const physicalScopeBoundaryFaces = (regions: ReadonlyArray<PhysicalSceneBounds>): ReadonlyArray<PhysicalScopeFace> => regions.flatMap((region, index) => [0, 1, 2].flatMap(axis => ([-1, 1] as const).flatMap(outward => {
  const coordinate = outward === -1 ? region.min[axis]! : region.max[axis]!, axes = [(axis + 1) % 3, (axis + 2) % 3] as const
  let faces: PhysicalScopeFace[] = [{ axis, coordinate, outward, axes, min: axes.map(axis => region.min[axis]!) as [number, number], max: axes.map(axis => region.max[axis]!) as [number, number] }]
  for (let other = 0; other < regions.length; other++) if (other !== index) {
    const next = regions[other]!, across = outward === 1 ? next.min[axis]! <= coordinate && next.max[axis]! > coordinate : next.min[axis]! < coordinate && next.max[axis]! >= coordinate
    if (across) faces = faces.flatMap(face => subtractRectangle(face, next))
  }
  return faces
})))
