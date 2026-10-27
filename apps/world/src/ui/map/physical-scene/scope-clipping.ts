import earcut from 'earcut'
import type { PackPhysicalScene, PhysicalSceneBounds, PhysicalSceneObject } from '../../../core/packs/scene.ts'
import { meshBounds, type PhysicalMesh } from './geometry.ts'
import type { PhysicalPreparationView } from './preparation.ts'
import { physicalScopeRegions, disjointPhysicalScopeRegions, physicalScopeBoundaryFaces, type PhysicalScopeFace } from './scope-regions.ts'

type V3 = readonly [number, number, number]
type Vertex = readonly [number, number, number, number, number, number, number]
type RouteObject = PhysicalSceneObject & { readonly clipToScope?: true; readonly spatialPath?: { readonly points: ReadonlyArray<V3>; readonly radius: number } }
const position = (p: Vertex): V3 => [p[0], p[1], p[2]]
const compare = (a: Vertex, b: Vertex) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
/** The same source edge always evaluates in the same direction. Its plane
 * coordinate is exact; neighbouring triangles do not create two ULP variants. */
const crossing = (a: Vertex, b: Vertex, axis: number, coordinate: number): Vertex => {
  if (compare(a, b) > 0) [a, b] = [b, a]
  const ratio = (coordinate - a[axis]!) / (b[axis]! - a[axis]!)
  return a.map((value, component) => component === axis ? coordinate : component === 6 ? a[6] : value + (b[component]! - value) * ratio) as unknown as Vertex
}
const clipPlane = (polygon: ReadonlyArray<Vertex>, axis: number, coordinate: number, keepAbove: boolean): Vertex[] => {
  const result: Vertex[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, insideA = keepAbove ? a[axis]! >= coordinate : a[axis]! <= coordinate, insideB = keepAbove ? b[axis]! >= coordinate : b[axis]! <= coordinate
    if (insideA) result.push(a)
    if (insideA !== insideB) result.push(crossing(a, b, axis, coordinate))
  }
  return result
}
const clipBox = (polygon: ReadonlyArray<Vertex>, box: PhysicalSceneBounds): Vertex[] => {
  let result = [...polygon]
  for (let axis = 0; axis < 3 && result.length; axis++) result = clipPlane(clipPlane(result, axis, box.min[axis]!, true), axis, box.max[axis]!, false)
  return result
}
const append = (output: number[], polygon: ReadonlyArray<Vertex>): void => {
  for (let i = 1; i < polygon.length - 1; i++) {
    const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!, u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) > 0) output.push(...a, ...b, ...c)
  }
}
const vertex = (values: ArrayLike<number>, at: number): Vertex => [values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!, values[at + 4]!, values[at + 5]!, values[at + 6]!]
const raw = (object: PhysicalSceneObject): Float64Array => {
  const result: number[] = [], count = object.indices?.length ?? object.positions.length / 3
  for (let at = 0; at < count; at += 3) {
    const ids = [0, 1, 2].map(offset => object.indices?.[at + offset] ?? at + offset), p = ids.map(index => object.positions.slice(index * 3, index * 3 + 3)), a = p[1]!.map((v, axis) => v - p[0]![axis]!), b = p[2]!.map((v, axis) => v - p[0]![axis]!), n = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!], length = Math.hypot(...n)
    for (const index of ids) result.push(object.positions[index * 3]!, object.positions[index * 3 + 1]!, object.positions[index * 3 + 2]!, object.normals?.[index * 3] ?? n[0]! / (length || 1), object.normals?.[index * 3 + 1] ?? n[1]! / (length || 1), object.normals?.[index * 3 + 2] ?? n[2]! / (length || 1), object.materialIndices?.[index] ?? 0)
  }
  return Float64Array.from(result)
}
const area = (points: ReadonlyArray<V3>, axes: readonly [number, number]) => points.reduce((sum, p, index) => { const q = points[(index + 1) % points.length]!; return sum + p[axes[0]]! * q[axes[1]]! - q[axes[0]]! * p[axes[1]]! }, 0) / 2
const contains = (loop: ReadonlyArray<V3>, p: V3, axes: readonly [number, number]): boolean => {
  let inside = false
  const [x, y] = axes
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const a = loop[i]!, b = loop[j]!; if ((a[y]! > p[y]!) !== (b[y]! > p[y]!) && p[x]! < (b[x]! - a[x]!) * (p[y]! - a[y]!) / (b[y]! - a[y]!) + a[x]!) inside = !inside }
  return inside
}
/** Closed cross-sections of the ORIGINAL closed tube, independent of which
 * other clipping planes meet this face. Nested loops retain real holes. */
const section = (vertices: Float64Array, face: PhysicalScopeFace, material: number, label: string, coordinateScale: number): ReadonlyArray<ReadonlyArray<Vertex>> => {
  const points: V3[] = [], edges = new Set<string>(), neighbours = new Map<number, Set<number>>()
  const error = 32 * Number.EPSILON * coordinateScale
  const pointId = (p: V3) => { const found = points.findIndex(q => p.every((value, axis) => Math.abs(value - q[axis]!) <= error)); if (found >= 0) return found; points.push(p); return points.length - 1 }
  for (let at = 0; at < vertices.length; at += 21) {
    const triangle = [vertex(vertices, at), vertex(vertices, at + 7), vertex(vertices, at + 14)]
    if (triangle.every(p => p[face.axis] === face.coordinate)) continue
    const intersections: number[] = []
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge]!, b = triangle[(edge + 1) % 3]!, da = a[face.axis]! - face.coordinate, db = b[face.axis]! - face.coordinate
      if (!da) intersections.push(pointId(position(a)))
      if (da < 0 && db > 0 || da > 0 && db < 0) intersections.push(pointId(position(crossing(a, b, face.axis, face.coordinate))))
    }
    const ids = [...new Set(intersections)]
    if (ids.length !== 2) continue
    const key = [...ids].sort((a, b) => a - b).join(','); if (edges.has(key)) continue; edges.add(key)
    for (const [a, b] of [ids, [...ids].reverse()]) { const set = neighbours.get(a!) ?? new Set(); set.add(b!); neighbours.set(a!, set) }
  }
  const loops: V3[][] = [], visited = new Set<number>()
  for (const start of neighbours.keys()) {
    if (visited.has(start)) continue
    const component: number[] = [], pending = [start]
    while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); component.push(id); pending.push(...neighbours.get(id)!) }
    if (component.some(id => neighbours.get(id)!.size !== 2)) {
      const a = points[component[0]!]!, b = points[component[1]!]!, [x, y] = face.axes
      if (component.every(id => { const p = points[id]!, left = (b[x]! - a[x]!) * (p[y]! - a[y]!), right = (b[y]! - a[y]!) * (p[x]! - a[x]!); return Math.abs(left - right) <= 32 * Number.EPSILON * (Math.abs(left) + Math.abs(right)) })) continue
      throw Error(`Unable to form a closed inspection cut for ${label}`)
    }
    const loop: V3[] = []; let previous = -1, current = start
    do { loop.push(points[current]!); const next = [...neighbours.get(current)!].find(id => id !== previous)!; previous = current; current = next } while (current !== start)
    if (Math.abs(area(loop, face.axes)) > 0) loops.push(loop)
  }
  const sizes = loops.map(loop => Math.abs(area(loop, face.axes))), parents = loops.map((loop, index) => { let parent = -1; for (let other = 0; other < loops.length; other++) if (sizes[other]! > sizes[index]! && contains(loops[other]!, loop[0]!, face.axes) && (parent < 0 || sizes[other]! < sizes[parent]!)) parent = other; return parent })
  const depth = (index: number): number => parents[index]! < 0 ? 0 : 1 + depth(parents[index]!)
  const normal: [number, number, number] = [0, 0, 0]; normal[face.axis] = face.outward
  const result: Vertex[][] = []
  for (let index = 0; index < loops.length; index++) {
    if (depth(index) % 2) continue
    const polygon = [...loops[index]!], holes: number[] = []
    for (let child = 0; child < loops.length; child++) if (parents[child] === index) { holes.push(polygon.length); polygon.push(...loops[child]!) }
    const indices = earcut(polygon.flatMap(p => [p[face.axes[0]]!, p[face.axes[1]]!]), holes, 2)
    for (let at = 0; at < indices.length; at += 3) {
      const triangle = indices.slice(at, at + 3).map(index => polygon[index]!)
      if (Math.sign(area(triangle, face.axes)) !== face.outward) triangle.reverse()
      result.push(triangle.map(p => [...p, ...normal, material] as Vertex))
    }
  }
  return result
}

/** Exact selected-scope/floor INTERSECTION of opted-in continuous routes.
 * It changes only cached display geometry and keeps the physical occurrence,
 * graph correspondence and source path unchanged. No selected scope means the
 * full site; floor cuts still receive real closed continuation sections. */
export const clipPhysicalMeshesToScope = (scene: PackPhysicalScene, view: PhysicalPreparationView, meshes: ReadonlyArray<PhysicalMesh>): ReadonlyArray<PhysicalMesh> => {
  if (view.mode !== '3d') return meshes
  const selected = physicalScopeRegions(scene, view.scopeId)
  if (!selected.length && view.levelId === 'all' && view.separation === 0) return meshes
  return meshes.flatMap(mesh => {
    const object = mesh.object as RouteObject
    if (!object.clipToScope) return [mesh]
    if (!object.spatialPath) throw Error(`Scoped physical route has no spatial path: ${object.id}`)
    const bounds = object.bounds ?? mesh.bounds, floor = object.levelId !== 'site' && (view.levelId !== 'all' || view.separation > 0) ? object.inspectionLevels?.find(level => level.levelId === mesh.levelId) : undefined
    const regions = (selected.length ? selected : [bounds]).map(region => ({ min: region.min.map((value, axis) => axis === 2 && floor ? Math.max(value, floor.low) : value) as [number, number, number], max: region.max.map((value, axis) => axis === 2 && floor ? Math.min(value, floor.high) : value) as [number, number, number] })).filter(region => region.min.every((value, axis) => value < region.max[axis]!))
    if (!regions.some(region => region.min.every((value, axis) => value < bounds.max[axis]! && region.max[axis]! > bounds.min[axis]!))) return []
    const tagged = { ...mesh, ...(view.scopeId ? { inspectionScopeId: view.scopeId } : {}) }
    if (regions.some(region => region.min.every((value, axis) => value <= bounds.min[axis]! && region.max[axis]! >= bounds.max[axis]!))) return [tagged]
    const cells = disjointPhysicalScopeRegions(regions), boundary = physicalScopeBoundaryFaces(cells), source = raw(object), output: number[] = [], roles = [...(mesh.materials ?? object.materials ?? [object.material ?? object.kind])], coordinateScale = Math.max(...bounds.min.map(Math.abs), ...bounds.max.map(Math.abs))
    const continuation = `continuation/${object.material ?? roles[0]!}/${object.spatialPath.radius}`, material = roles.length; roles.push(continuation)
    for (let at = 0; at < source.length; at += 21) for (const cell of cells) append(output, clipBox([vertex(source, at), vertex(source, at + 7), vertex(source, at + 14)], cell))
    const sections = new Map<string, ReadonlyArray<ReadonlyArray<Vertex>>>()
    for (const face of boundary) {
      if (face.coordinate < bounds.min[face.axis]! || face.coordinate > bounds.max[face.axis]!) continue
      const key = `${face.axis}/${face.coordinate}/${face.outward}`
      let caps = sections.get(key)
      if (!caps) { caps = section(source, face, material, object.id, coordinateScale); sections.set(key, caps) }
      for (const triangle of caps) {
        let polygon = [...triangle]
        for (let axis = 0; axis < 2 && polygon.length; axis++) polygon = clipPlane(clipPlane(polygon, face.axes[axis]!, face.min[axis]!, true), face.axes[axis]!, face.max[axis]!, false)
        append(output, polygon)
      }
    }
    if (!output.length) return []
    // Existing terminal feature strokes are clipped against the same union.
    const lines: number[] = [], materials: string[] = [], styles: Array<'feature' | 'context' | 'section'> = [], seen = new Set<string>()
    for (let at = 0; at < mesh.lines.length; at += 6) for (const cell of cells) {
      let a = mesh.lines.slice(at, at + 3) as unknown as V3, b = mesh.lines.slice(at + 3, at + 6) as unknown as V3, visible = true
      for (let axis = 0; axis < 3; axis++) for (const [coordinate, above] of [[cell.min[axis]!, true], [cell.max[axis]!, false]] as const) {
        const inA = above ? a[axis]! >= coordinate : a[axis]! <= coordinate, inB = above ? b[axis]! >= coordinate : b[axis]! <= coordinate
        if (!inA && !inB) { visible = false; break }
        if (inA !== inB) { const p = position(crossing([...a, 0, 0, 1, 0], [...b, 0, 0, 1, 0], axis, coordinate)); if (inA) b = p; else a = p }
      }
      if (!visible || a.every((value, axis) => value === b[axis])) continue
      const role = mesh.lineMaterials?.[at / 6] ?? 'line', style = mesh.lineStyles?.[at / 6] ?? 'feature', key = [a.join(','), b.join(',')].sort().join('|') + `/${role}/${style}`
      if (seen.has(key)) continue; seen.add(key); lines.push(...a, ...b); materials.push(role); styles.push(style)
    }
    return [{ ...tagged, key: `${mesh.key}/spatial/${view.scopeId ?? 'floors'}`, vertices: Float64Array.from(output), lines: Float64Array.from(lines), materials: roles, lineMaterials: materials, lineStyles: styles, bounds: meshBounds(output) }]
  })
}
