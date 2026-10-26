import earcut from 'earcut'
import { createMesh, materialRoles, type Mesh } from '../explorer/mesh.ts'
import { solid as explorerSolid } from '../explorer/solid.ts'
import type { RenderObject } from '../explorer/architecture.ts'
import { elementWorld, parameters, type Source, type Element, type V3 } from './source.ts'

const internal = ([x, y, z]: V3): V3 => [x, z, y]
const section = (mesh: Mesh, element: Element, dimensions: ReturnType<typeof parameters>): void => {
  const member = element.member!
  if (member.kind !== 'i-section') return
  const [width, depth, length] = member.axis === 'z' ? [dimensions.length, dimensions.width, dimensions.height] : member.axis === 'x' ? [dimensions.width, dimensions.height, dimensions.length] : [dimensions.length, dimensions.height, dimensions.width]
  const a = (width - member.web) / 2, b = a + member.web, t = member.flange
  const ring: Array<[number, number]> = [[0, 0], [width, 0], [width, t], [b, t], [b, depth - t], [width, depth - t], [width, depth], [0, depth], [0, depth - t], [a, depth - t], [a, t], [0, t]]
  const p = ([u, v]: [number, number], at: number): V3 => internal(member.axis === 'z' ? [u, v, at] : member.axis === 'x' ? [at, u, v] : [u, at, v])
  const indices = earcut(ring.flat(), undefined, 2), material = materialRoles.indexOf(element.material ?? 'steel')
  for (let index = 0; index < indices.length; index += 3) {
    const [a, b, c] = indices.slice(index, index + 3).map(index => ring[index]!) as [[number, number], [number, number], [number, number]]
    mesh.tri(p(c, 0), p(b, 0), p(a, 0), material)
    mesh.tri(p(a, length), p(b, length), p(c, length), material)
  }
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!, b = ring[(index + 1) % ring.length]!
    mesh.quad(p(a, 0), p(b, 0), p(b, length), p(a, length), material)
    mesh.line(p(a, 0), p(b, 0)); mesh.line(p(a, length), p(b, length)); mesh.line(p(a, 0), p(a, length))
  }
}

/** Reusable authored member recipes, with no component- or plant-specific drawing paths. */
export const solid = (source: Source, element: Element): RenderObject | null => {
  if (!element.member || element.disposition === 'removed') return explorerSolid(source, element)
  const mesh = createMesh(), dimensions = parameters(source, element), member = element.member
  const material = materialRoles.indexOf(element.material ?? 'steel')
  if (member.kind === 'i-section') section(mesh, element, dimensions)
  else if (member.kind === 'tube') {
    for (let index = 0; index < member.points.length - 1; index++) mesh.cylinder(internal(member.points[index]!), internal(member.points[index + 1]!), member.radius, material, 12)
  } else if (member.kind === 'guardrail') {
    for (let index = 0; index < member.points.length - 1; index++) {
      const a = member.points[index]!, b = member.points[index + 1]!, posts = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / member.postSpacing)
      const top = (point: V3): V3 => [point[0], point[1], point[2] + member.height]
      mesh.cylinder(internal(top(a)), internal(top(b)), member.railRadius, material, 12)
      for (let post = 0; post <= posts; post++) {
        const point = a.map((value, axis) => value + (b[axis]! - value) * post / posts) as V3
        mesh.cylinder(internal(point), internal(top(point)), member.postRadius, material, 8)
      }
    }
  } else mesh.frustum(0, 0, 0, dimensions.length, dimensions.width, dimensions.height, member.topLength, member.topWidth, material)
  const pose = elementWorld(source, element), c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
  const world = ([x, y, z]: V3): V3 => [pose.position[0] + c * x - s * y, pose.position[1] + s * x + c * y, pose.position[2] + z]
  const positions: number[] = [], normals: number[] = [], materialIndices: number[] = [], linePositions: number[] = []
  for (let index = 0; index < mesh.vertices.length; index += 7) {
    positions.push(...world([mesh.vertices[index]!, mesh.vertices[index + 2]!, mesh.vertices[index + 1]!]))
    const x = mesh.vertices[index + 3]!, y = mesh.vertices[index + 5]!
    normals.push(c * x - s * y, s * x + c * y, mesh.vertices[index + 4]!); materialIndices.push(mesh.vertices[index + 6]!)
  }
  for (let index = 0; index < mesh.lines.length; index += 3) linePositions.push(...world([mesh.lines[index]!, mesh.lines[index + 2]!, mesh.lines[index + 1]!]))
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < positions.length; index++) { const axis = index % 3; min[axis] = Math.min(min[axis]!, positions[index]!); max[axis] = Math.max(max[axis]!, positions[index]!) }
  return { id: element.id, sourceElementId: element.id, label: element.label, kind: element.kind, levelId: element.levelId, positions, normals, materials: [...materialRoles], materialIndices, linePositions, bounds: { min, max } }
}
