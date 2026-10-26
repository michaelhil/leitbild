import type { PhysicalMesh } from './geometry.ts'
import { meshBounds } from './geometry.ts'
import { cross, subtract, type Vector3 } from './math.ts'
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
const point = (v: Vertex): Vector3 => [v[0], v[1], v[2]]
const vertex = (values: ArrayLike<number>, at: number): Vertex => [values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!, values[at + 4]!, values[at + 5]!, values[at + 6]!]

/** orient3d's forward-error bound depends on its products, not a metric epsilon. */
const onPlane = (triangle: readonly Vertex[], p: Vertex): boolean => {
  const a = subtract(point(triangle[0]!), point(p)), b = subtract(point(triangle[1]!), point(p)), c = subtract(point(triangle[2]!), point(p))
  const products = [b[0] * c[1], c[0] * b[1], c[0] * a[1], a[0] * c[1], a[0] * b[1], b[0] * a[1]]
  const determinant = a[2] * (products[0]! - products[1]!) + b[2] * (products[2]! - products[3]!) + c[2] * (products[4]! - products[5]!)
  const permanent = Math.abs(a[2]) * (Math.abs(products[0]!) + Math.abs(products[1]!)) + Math.abs(b[2]) * (Math.abs(products[2]!) + Math.abs(products[3]!)) + Math.abs(c[2]) * (Math.abs(products[4]!) + Math.abs(products[5]!))
  return Math.abs(determinant) <= (7 + 56 * Number.EPSILON) * Number.EPSILON * permanent
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
  const axes = cover.axes, orientation = Math.sign(distance(cover.vertices[0]!, cover.vertices[1]!, cover.vertices[2]!, axes)), pieces: Region[] = []
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
const append = (output: number[], polygon: readonly Vertex[]): void => { for (let corner = 1; corner < polygon.length - 1; corner++) output.push(...polygon[0]!, ...polygon[corner]!, ...polygon[corner + 1]!) }

/** Retain all coincident alternatives. Only the display's visible candidates choose a winner. */
export const preparePhysicalSurfaceOwnership = (meshes: ReadonlyArray<PhysicalMesh>): { readonly meshes: ReadonlyArray<PhysicalMesh>; readonly diagnostics: PhysicalSurfaceOwnershipDiagnostics } => {
  const cohorts = new Map<string, Face[]>(), pieces = meshes.map(() => new Map<string, { coveredBy: readonly string[]; vertices: number[] }>()), pairs = new Map<string, { first: string; later: string; area: number }>()
  let triangles = 0, partitionedTriangles = 0, broadPhaseCandidates = 0, coplanarCandidates = 0
  meshes.forEach((mesh, meshIndex) => {
    const key = `${mesh.planPriority ?? 'physical'}|${mesh.offset.join(',')}`, faces = cohorts.get(key) ?? []
    for (let at = 0; at < mesh.vertices.length; at += 21) {
      const vertices = [vertex(mesh.vertices, at), vertex(mesh.vertices, at + 7), vertex(mesh.vertices, at + 14)], normal = cross(subtract(point(vertices[1]!), point(vertices[0]!)), subtract(point(vertices[2]!), point(vertices[0]!))), absolute = normal.map(Math.abs), dominant = absolute.indexOf(Math.max(...absolute))
      if (absolute[dominant] === 0) continue
      const axes = [(dominant + 1) % 3, (dominant + 2) % 3] as const
      faces.push({ mesh: meshIndex, vertices, normal, axes, bounds: meshBounds(vertices.flat()) }); triangles++
    }
    cohorts.set(key, faces)
  })
  for (const faces of cohorts.values()) {
    const index = createPhysicalSpatialIndex(faces.map(face => face.bounds))
    faces.forEach((face, faceIndex) => {
      const candidates: number[] = []; visitPhysicalSpatialBounds(index, face.bounds, candidate => { if (candidate < faceIndex) candidates.push(candidate) }); candidates.sort((a, b) => a - b); broadPhaseCandidates += candidates.length
      let regions: readonly Region[] = [{ vertices: face.vertices, coveredBy: [] }]
      for (const candidate of candidates) {
        const cover = faces[candidate]!
        if (!cover.vertices.every(value => onPlane(face.vertices, value))) continue
        coplanarCandidates++
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
      for (const region of regions) { const key = JSON.stringify(region.coveredBy), group = target.get(key) ?? { coveredBy: region.coveredBy, vertices: [] }; append(group.vertices, region.vertices); target.set(key, group) }
    })
  }
  const result: PhysicalMesh[] = []
  meshes.forEach((mesh, index) => {
    const groups = pieces[index]!, base = groups.get('[]')
    // Authored strokes remain attached to their occurrence; depth occlusion still
    // applies. Candidate patches contain solids only and never duplicate strokes.
    result.push({ ...mesh, vertices: Float64Array.from(base?.vertices ?? []), bounds: base?.vertices.length ? meshBounds(base.vertices) : mesh.bounds })
    for (const [key, group] of groups) if (key !== '[]') result.push({ ...mesh, vertices: Float64Array.from(group.vertices), bounds: meshBounds(group.vertices), lines: new Float64Array(), lineMaterials: [], lineStyles: [], occludedBy: group.coveredBy })
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
