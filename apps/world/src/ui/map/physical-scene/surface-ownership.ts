import type { PhysicalMesh } from './geometry.ts'
import { meshBounds } from './geometry.ts'
import { type Vector3 } from './math.ts'
import { derivePhysicalPickAcceleration, type PhysicalPickAcceleration } from './picking.ts'
import { createPhysicalSpatialIndex, visitPhysicalSpatialBounds } from './spatial-index.ts'

/** A deterministic display tie, not a change to physical/material ownership. */
export interface PhysicalSurfaceOwnershipDiagnostics {
  readonly broadPhaseCandidates: number
  readonly coplanarCandidates: number
  readonly triangles: number
  readonly partitionedTriangles: number
  readonly retainedCandidates: number
  readonly coincidentPairs: ReadonlyArray<{ readonly first: string; readonly later: string; readonly area: number }>
}
type Vertex = readonly [number, number, number, number, number, number, number]
interface Face { readonly mesh: number; readonly vertices: readonly Vertex[]; readonly axes: readonly [number, number]; readonly normal: Vector3; readonly bounds: ReturnType<typeof meshBounds> }
interface Region { readonly vertices: readonly Vertex[]; readonly coveredBy: readonly string[] }
const vertex = (values: ArrayLike<number>, at: number): Vertex => [values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!, values[at + 4]!, values[at + 5]!, values[at + 6]!]

/** orient3d's forward-error bound depends on its products, not a metric epsilon. */
const onPlane = (triangle: readonly Vertex[], p: Vertex): boolean => {
  const a = triangle[0]!, b = triangle[1]!, c = triangle[2]!
  const ax = a[0]-p[0], ay = a[1]-p[1], az = a[2]-p[2], bx = b[0]-p[0], by = b[1]-p[1], bz = b[2]-p[2], cx = c[0]-p[0], cy = c[1]-p[1], cz = c[2]-p[2]
  const p0=bx*cy, p1=cx*by, p2=cx*ay, p3=ax*cy, p4=ax*by, p5=bx*ay
  const determinant = az*(p0-p1)+bz*(p2-p3)+cz*(p4-p5)
  const permanent = Math.abs(az)*(Math.abs(p0)+Math.abs(p1))+Math.abs(bz)*(Math.abs(p2)+Math.abs(p3))+Math.abs(cz)*(Math.abs(p4)+Math.abs(p5))
  return Math.abs(determinant) <= (7+56*Number.EPSILON)*Number.EPSILON*permanent
}
const distance = (a: Vertex, b: Vertex, p: Vertex, axes: readonly [number, number]): number => {
  const [x, y] = axes, left = (b[x]! - a[x]!) * (p[y]! - a[y]!), right = (b[y]! - a[y]!) * (p[x]! - a[x]!), value = left - right
  return Math.abs(value) <= (3 + 16 * Number.EPSILON) * Number.EPSILON * (Math.abs(left) + Math.abs(right)) ? 0 : value
}
const area = (polygon: readonly Vertex[], axes: readonly [number, number]): number => {
  let sum = 0, magnitude = 0
  for (let at = 1; at < polygon.length - 1; at++) {
    const value = distance(polygon[0]!, polygon[at]!, polygon[at + 1]!, axes); sum += value; magnitude += Math.abs(value)
  }
  return Math.abs(sum) > (polygon.length * 4 + 2) * Number.EPSILON * magnitude ? Math.abs(sum) / 2 : 0
}
const interpolate = (a: Vertex, b: Vertex, fraction: number): Vertex => a.map((value, component) => component === 6 ? a[6] : value + (b[component]! - value) * fraction) as unknown as Vertex
const split = (polygon: readonly Vertex[], a: Vertex, b: Vertex, axes: readonly [number, number], orientation: number): { inside: readonly Vertex[]; outside: readonly Vertex[] } => {
  const distances = polygon.map(v => distance(a, b, v, axes) * orientation)
  if (distances.every(value => value >= 0)) return { inside: polygon, outside: [] }
  if (distances.every(value => value <= 0)) return { inside: [], outside: polygon }
  const inside: Vertex[] = [], outside: Vertex[] = []
  for (let index = 0; index < polygon.length; index++) {
    const start = polygon[index]!, end = polygon[(index + 1) % polygon.length]!, da = distances[index]!, db = distances[(index + 1) % polygon.length]!
    if (da >= 0) inside.push(start)
    if (da <= 0) outside.push(start)
    if (da * db < 0) { const crossing = interpolate(start, end, da / (da - db)); inside.push(crossing); outside.push(crossing) }
  }
  return { inside, outside }
}
const partition = (region: Region, cover: Face, owner: string): { regions: readonly Region[]; overlap: number } => {
  if (region.coveredBy.includes(owner)) return { regions: [region], overlap: 0 }
  const axes = cover.axes, orientation = Math.sign(cover.normal[3 - axes[0] - axes[1]]!), pieces: Region[] = []
  let remaining = region.vertices
  for (let edge = 0; edge < 3 && remaining.length; edge++) {
    const result = split(remaining, cover.vertices[edge]!, cover.vertices[(edge + 1) % 3]!, axes, orientation)
    if (area(result.outside, axes) > 0) pieces.push({ vertices: result.outside, coveredBy: region.coveredBy })
    remaining = result.inside
  }
  const overlap = area(remaining, axes)
  if (!(overlap > 0)) return { regions: [region], overlap: 0 }
  pieces.push({ vertices: remaining, coveredBy: [...region.coveredBy, owner] })
  return { regions: pieces, overlap: overlap * Math.hypot(...cover.normal) / Math.abs(cover.normal[3 - axes[0] - axes[1]]!) }
}
interface Vertices { values: Float64Array; length: number }
const storage = (capacity: number): Vertices => ({ values: new Float64Array(capacity), length: 0 })
/** Sequential typed storage avoids constructing a second boxed-number copy of
 * every prepared triangle. Capacity follows actual geometry; it is not an
 * admission limit. The final asset owns exactly its used bytes. */
const append = (output: Vertices, polygon: readonly Vertex[]): void => {
  const required = output.length + Math.max(0, polygon.length - 2) * 21
  if (required > output.values.length) { const grown = new Float64Array(Math.max(required, output.values.length * 2)); grown.set(output.values); output.values = grown }
  for (let corner = 1; corner < polygon.length - 1; corner++) for (const point of [polygon[0]!, polygon[corner]!, polygon[corner + 1]!]) for (let component = 0; component < 7; component++) output.values[output.length++] = point[component]!
}
const finish = (vertices: Vertices): Float64Array => vertices.length === vertices.values.length ? vertices.values : vertices.values.slice(0, vertices.length)


/** Retain all coincident alternatives. Only the display's visible candidates choose a winner. */
export const preparePhysicalSurfaceOwnership = (meshes: ReadonlyArray<PhysicalMesh>): { readonly meshes: ReadonlyArray<PhysicalMesh>; readonly diagnostics: PhysicalSurfaceOwnershipDiagnostics } => {
  const cohorts = new Map<string, Face[]>(), pieces = meshes.map(() => new Map<string, { coveredBy: readonly string[]; vertices: Vertices }>()), pairs = new Map<string, { first: string; later: string; area: number }>()
  let triangles = 0, partitionedTriangles = 0, broadPhaseCandidates = 0, coplanarCandidates = 0
  meshes.forEach((mesh, meshIndex) => {
    const key = `${mesh.planPriority ?? 'physical'}|${mesh.offset.join(',')}`, faces = cohorts.get(key) ?? []
    for (let at = 0; at < mesh.vertices.length; at += 21) {
      const vertices = [vertex(mesh.vertices, at), vertex(mesh.vertices, at + 7), vertex(mesh.vertices, at + 14)], [a, b, c] = vertices as [Vertex, Vertex, Vertex]
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2], normal: Vector3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
      const nx = Math.abs(normal[0]), ny = Math.abs(normal[1]), nz = Math.abs(normal[2]), dominant = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2
      if (normal[dominant] === 0) continue
      const axes = [(dominant + 1) % 3, (dominant + 2) % 3] as const
      faces.push({ mesh: meshIndex, vertices, normal, axes, bounds: { min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])], max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])] } }); triangles++
    }
    cohorts.set(key, faces)
  })
  for (const faces of cohorts.values()) {
    const index = createPhysicalSpatialIndex(faces.map(face => face.bounds), 'overlap')
    faces.forEach((face, faceIndex) => {
      const candidates: number[] = []
      let earlierCandidates = 0
      visitPhysicalSpatialBounds(index, face.bounds, candidate => {
        if (candidate >= faceIndex) return
        earlierCandidates++
        const cover = faces[candidate]!
        // These predicates depend only on immutable faces. Apply them before
        // storing/sorting candidates; only the surviving faces need source order.
        const x=cover.axes[0], y=cover.axes[1]
        if (Math.min(face.bounds.max[x]!,cover.bounds.max[x]!) <= Math.max(face.bounds.min[x]!,cover.bounds.min[x]!) || Math.min(face.bounds.max[y]!,cover.bounds.max[y]!) <= Math.max(face.bounds.min[y]!,cover.bounds.min[y]!)) return
        if (!onPlane(face.vertices,cover.vertices[0]!) || !onPlane(face.vertices,cover.vertices[1]!) || !onPlane(face.vertices,cover.vertices[2]!)) return
        candidates.push(candidate)
      })
      broadPhaseCandidates += earlierCandidates
      coplanarCandidates += candidates.length
      candidates.sort((a,b)=>a-b)
      let regions: readonly Region[] = [{ vertices: face.vertices, coveredBy: [] }]
      for (const candidate of candidates) {
        const cover = faces[candidate]!
        const owner = meshes[cover.mesh]!.key, next: Region[] = []
        for (const region of regions) {
          const result = partition(region, cover, owner); next.push(...result.regions)
          if (result.overlap > 0) {
            const first = meshes[cover.mesh]!.object.id, later = meshes[face.mesh]!.object.id, pairKey = JSON.stringify([first, later]), pair = pairs.get(pairKey) ?? { first, later, area: 0 }; pair.area += result.overlap; pairs.set(pairKey, pair)
          }
        }
        regions = next
      }
      if (regions.some(region => region.coveredBy.length)) partitionedTriangles++
      const target = pieces[face.mesh]!
      for (const region of regions) { const key = JSON.stringify(region.coveredBy), group = target.get(key) ?? { coveredBy: region.coveredBy, vertices: storage(key === '[]' ? meshes[face.mesh]!.vertices.length : Math.max(0, region.vertices.length - 2) * 21) }; append(group.vertices, region.vertices); target.set(key, group) }
    })
  }
  const result: PhysicalMesh[] = []
  meshes.forEach((mesh, index) => {
    const groups = pieces[index]!, base = groups.get('[]')
    // Authored strokes remain attached to their occurrence; depth occlusion still
    // applies. Candidate patches contain solids only and never duplicate strokes.
    const baseVertices = base ? finish(base.vertices) : new Float64Array()
    result.push({ ...mesh, vertices: baseVertices, bounds: baseVertices.length ? meshBounds(baseVertices) : mesh.bounds })
    for (const [key, group] of groups) if (key !== '[]') { const vertices = finish(group.vertices); result.push({ ...mesh, vertices, bounds: meshBounds(vertices), lines: new Float64Array(), lineMaterials: [], lineStyles: [], occludedBy: group.coveredBy }) }
  })
  return { meshes: result, diagnostics: { broadPhaseCandidates, coplanarCandidates, triangles, partitionedTriangles, retainedCandidates: result.length - meshes.length, coincidentPairs: [...pairs.values()] } }
}

const visible = new WeakMap<ReadonlyArray<PhysicalMesh>, ReadonlyArray<PhysicalMesh>>(), indexed = new WeakSet<ReadonlyArray<PhysicalMesh>>()
export const visiblePhysicalSurfaceOwners = (meshes: ReadonlyArray<PhysicalMesh>, acceleration?: PhysicalPickAcceleration): ReadonlyArray<PhysicalMesh> => {
  let selected = visible.get(meshes)
  if (!selected) {
    const candidates = new Set(meshes.map(mesh => mesh.key))
    selected = meshes.some(mesh => mesh.occludedBy?.length) ? meshes.filter(mesh => !mesh.occludedBy?.some(owner => candidates.has(owner))) : meshes
    visible.set(meshes, selected)
  }
  if (acceleration && selected !== meshes && !indexed.has(selected)) { derivePhysicalPickAcceleration(selected, acceleration); indexed.add(selected) }
  return selected
}
