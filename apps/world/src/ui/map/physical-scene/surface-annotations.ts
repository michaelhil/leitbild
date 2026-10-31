import earcut from 'earcut'
import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
import { meshBounds, type PhysicalMesh } from './geometry.ts'
import type { PhysicalSceneView } from './types.ts'

type Point = readonly [number, number]
const cross = (a: Point, b: Point, p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
const interpolate = (a: Point, b: Point, fraction: number): Point => [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]
const area = (polygon: ReadonlyArray<Point>): number => polygon.reduce((sum, point, index) => {
  const next = polygon[(index + 1) % polygon.length]!
  return sum + point[0] * next[1] - next[0] * point[1]
}, 0) / 2
const clip = (polygon: ReadonlyArray<Point>, triangle: ReadonlyArray<Point>): Point[] => {
  let output = [...polygon]
  const orientation = Math.sign(area(triangle))
  for (let edge = 0; edge < 3 && output.length; edge++) {
    const a = triangle[edge]!, b = triangle[(edge + 1) % 3]!, result: Point[] = []
    for (let index = 0; index < output.length; index++) {
      const start = output[index]!, end = output[(index + 1) % output.length]!, from = cross(a, b, start) * orientation, to = cross(a, b, end) * orientation
      if (from >= 0) result.push(start)
      if ((from >= 0) !== (to >= 0)) result.push(interpolate(start, end, from / (from - to)))
    }
    output = result
  }
  return output
}
/** Floor-anchored work areas are surface decorations, not floating translucent
 * planes. Clip them to real upward floor faces and give the existing coplanar
 * ownership partition both alternatives. Hiding a layer restores the exact
 * retained floor; equipment and slab openings still occlude the illustration. */
export const physicalSurfaceAnnotations = (scene: PackPhysicalScene, view: PhysicalSceneView, meshes: ReadonlyArray<PhysicalMesh>): ReadonlyArray<PhysicalMesh> => {
  if (view.mode !== '3d' || !scene.planAnnotations?.some(annotation => annotation.kind === 'hatch')) return meshes
  const decorations: PhysicalMesh[] = []
  for (const annotation of scene.planAnnotations) {
    if (annotation.kind !== 'hatch' || view.levelId !== 'all' && !annotation.levelIds.includes(view.levelId) && !annotation.levelIds.includes('site')) continue
    const z = annotation.outline[0]![2]
    if (annotation.outline.some(point => point[2] !== z)) continue // A paper-only nonhorizontal annotation has no floor surface to decorate.
    const outline = annotation.outline.map(point => [point[0], point[1]] as const), indices = earcut(outline.flat(), undefined, 2)
    const minX = Math.min(...outline.map(point => point[0])), maxX = Math.max(...outline.map(point => point[0])), minY = Math.min(...outline.map(point => point[1])), maxY = Math.max(...outline.map(point => point[1]))
    for (const mesh of meshes) {
      if (mesh.object.kind !== 'slab' && mesh.object.kind !== 'pavement') continue
      if (mesh.object.levelId === 'site' ? !annotation.levelIds.includes('site') : mesh.levelId !== undefined && !annotation.levelIds.includes(mesh.levelId)) continue
      if (mesh.bounds.min[0] >= maxX || mesh.bounds.max[0] <= minX || mesh.bounds.min[1] >= maxY || mesh.bounds.max[1] <= minY || mesh.bounds.min[2] > z || mesh.bounds.max[2] < z) continue
      if (!mesh.object.scopeIds?.some(id => annotation.scopeIds.includes(id))) continue
      const vertices: number[] = [], roles: string[] = []
      for (let at = 0; at < mesh.vertices.length; at += 21) {
        const raw = mesh.vertices, ids = [at, at + 7, at + 14], face = ids.map(index => [raw[index]!, raw[index + 1]!] as const)
        if (ids.some(index => raw[index + 2] !== z || raw[index + 5]! <= 0) || area(face) === 0) continue
        const base = mesh.materials?.[raw[at + 6]!] ?? mesh.object.materials?.[raw[at + 6]!] ?? mesh.object.material ?? mesh.object.kind
        const role = `surface/${annotation.role === 'access' ? 'access' : 'outage'}/${base}`
        let material = roles.indexOf(role); if (material < 0) { material = roles.length; roles.push(role) }
        for (let index = 0; index < indices.length; index += 3) {
          const polygon = clip(indices.slice(index, index + 3).map(id => outline[id]!), face)
          if (polygon.length < 3 || !(area(polygon) > 0)) continue
          for (let corner = 1; corner < polygon.length - 1; corner++) for (const point of [polygon[0]!, polygon[corner]!, polygon[corner + 1]!]) vertices.push(point[0], point[1], z, 0, 0, 1, material)
        }
      }
      if (!vertices.length) continue
      decorations.push({ ...mesh, key: `${mesh.key}/annotation/${annotation.id}`, vertices: Float64Array.from(vertices), lines: new Float64Array(), materials: roles, lineMaterials: [], lineStyles: [], bounds: meshBounds(vertices), annotation: { id: annotation.id, scopeIds: annotation.scopeIds, ...(annotation.layerId ? { layerId: annotation.layerId } : {}) } })
    }
  }
  return decorations.length ? [...decorations, ...meshes] : meshes
}
