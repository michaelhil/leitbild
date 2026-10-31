import earcut from 'earcut'
import { createMesh, materialRoles, palette, type Mesh } from './mesh.ts'
import { solid as architectureSolid, type RenderObject } from './architecture.ts'
import { campusEquipmentMesh } from './families.ts'
import { elementWorld, turbineIslandFamilies, parameters, physicalStairFlights, type Element, type Source, type V3 } from './source.ts'

const worldPoint = (point: V3, pose: Element['pose']): V3 => {
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
  return [pose.position[0] + c * point[0] - s * point[1], pose.position[1] + s * point[0] + c * point[1], pose.position[2] + point[2]]
}
const ellipticalRing = (mesh: Mesh, length: number, width: number, height: number, thickness: number, dome: boolean): void => {
  const segments = 64, bands = dome ? 12 : 1
  const point = (band: number, segment: number, inside: boolean): [number, number, number] => {
    const a = segment * Math.PI * 2 / segments, b = dome ? band * Math.PI / (2 * bands) : 0
    const rx = length / 2 - (inside ? thickness : 0), rz = width / 2 - (inside ? thickness : 0)
    return [length / 2 + Math.cos(a) * rx * Math.cos(b), dome ? Math.sin(b) * (height - (inside ? thickness : 0)) : band * height, width / 2 + Math.sin(a) * rz * Math.cos(b)]
  }
  for (let band = 0; band < bands; band++) for (let segment = 0; segment < segments; segment++) {
    for (const inside of [false, true]) {
      const a = point(band, segment, inside), b = point(band, segment + 1, inside), c = point(band + 1, segment + 1, inside), d = point(band + 1, segment, inside)
      if (inside) mesh.quad(d, c, b, a, palette.wall)
      else mesh.quad(a, b, c, d, palette.wall)
    }
    if (band === 0) mesh.quad(point(0, segment, false), point(0, segment, true), point(0, segment + 1, true), point(0, segment + 1, false), palette.wall)
    if (!dome && band === bands - 1) mesh.quad(point(bands, segment, false), point(bands, segment + 1, false), point(bands, segment + 1, true), point(bands, segment, true), palette.wall)
    if (band === 0 || band === bands - 1) mesh.line(point(band === 0 ? 0 : bands, segment, false), point(band === 0 ? 0 : bands, segment + 1, false))
  }
}
const plate = (mesh: Mesh, length: number, width: number, height: number): void => {
  const segments = 64, centre = [length / 2, 0, width / 2] as const
  for (let segment = 0; segment < segments; segment++) {
    const point = (angle: number, y: number): [number, number, number] => [length / 2 + Math.cos(angle) * length / 2, y, width / 2 + Math.sin(angle) * width / 2]
    const a = segment * Math.PI * 2 / segments, b = (segment + 1) * Math.PI * 2 / segments
    mesh.tri([...centre], point(b, 0), point(a, 0), palette.floor)
    mesh.tri([centre[0], height, centre[2]], point(a, height), point(b, height), palette.floor)
    mesh.quad(point(a, 0), point(b, 0), point(b, height), point(a, height), palette.floor)
  }
}
const route = (mesh: Mesh, element: Element, width: number, height: number): void => {
  const path = element.path!
  for (let index = 0; index < path.length - 1; index++) {
    const a = path[index]!, b = path[index + 1]!, distance = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (element.kind === 'fence') {
      const postCount = Math.max(1, Math.ceil(distance / 6))
      for (let post = 0; post <= postCount; post++) {
        const t = post / postCount, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t, y = a[2] + (b[2] - a[2]) * t
        mesh.cylinder([x, y, z], [x, y + height, z], width / 2, palette.steel, 6)
      }
      for (const y of [.2 * height, .94 * height]) mesh.cylinder([a[0], a[2] + y, a[1]], [b[0], b[2] + y, b[1]], width / 3, palette.steel, 6)
    } else {
      mesh.cylinder([a[0], a[2], a[1]], [b[0], b[2], b[1]], width / 2, element.kind === 'conductor' ? palette.steel : palette.pipe, element.kind === 'conductor' ? 6 : 16)
    }
  }
}

const staircase = (mesh: Mesh, element: Element, dimensions: ReturnType<typeof parameters>): void => {
  const recipe = element.stair!, flights = physicalStairFlights(dimensions, recipe), width = recipe.flightWidth, landing = recipe.landingDepth
  mesh.box(.1, -.12, 0, dimensions.length - .2, .12, landing, palette.light)
  for (const flight of flights) {
    const x = flight.forward ? .15 : dimensions.length - .15 - width
    for (let step = 0; step < flight.steps; step++) {
      const z = landing + (flight.forward ? step : flight.steps - step - 1) * flight.tread
      mesh.box(x, flight.base + (step + 1) * flight.riser - .1, z, width, .1, flight.tread, palette.light, false)
    }
    const bottomZ = flight.forward ? landing : dimensions.width - landing, topZ = flight.forward ? dimensions.width - landing : landing
    const end = flight.base + flight.rise
    mesh.box(.1, end - .12, flight.forward ? dimensions.width - landing : 0, dimensions.length - .2, .12, landing, palette.light)
    for (const sideX of [x + .06, x + width - .06]) {
      mesh.cylinder([sideX, flight.base + 1.05, bottomZ], [sideX, end + 1.05, topZ], .025, palette.steel, 6)
      mesh.cylinder([sideX, flight.base - .04, bottomZ], [sideX, end - .04, topZ], .045, palette.steel, 6)
      mesh.cylinder([sideX, flight.base, bottomZ], [sideX, flight.base + 1.05, bottomZ], .022, palette.steel, 6)
      mesh.cylinder([sideX, end, topZ], [sideX, end + 1.05, topZ], .022, palette.steel, 6)
    }
  }
}

/** New profiles add shapes; inherited types use the unchanged admitted machinery implementation. */
export const solid = (source: Source, element: Element): RenderObject | null => {
  // Road centrelines remain inspectable source topology. Their joined pavement
  // is the drawing representation; never turn each segment into a closed box.
  if (['opening', 'space', 'assembly', 'building', 'road'].includes(element.kind) || element.disposition === 'removed') return null
  const originalKind = !['road', 'fence', 'conductor', 'pavement'].includes(element.kind)
  if (!element.shape && !element.stair && originalKind && (element.kind !== 'equipment' || turbineIslandFamilies.some(family => family === element.equipmentKind))) {
    const mesh = architectureSolid(source, element)
    if (mesh && element.material) mesh.materialIndices = mesh.materialIndices.map(() => materialRoles.indexOf(element.material!))
    return mesh
  }
  const dimensions = parameters(source, element), pose = elementWorld(source, element)
  let mesh: Mesh
  if (element.kind === 'equipment') mesh = campusEquipmentMesh(element, dimensions)
  else {
    mesh = createMesh()
    if (element.kind === 'pavement') {
      for (const polygon of element.surface!) {
        const vertices = polygon.flat(), holes: number[] = [];
        let offset = polygon[0]!.length;
        for (const ring of polygon.slice(1)) { holes.push(offset); offset += ring.length }
        const indices = earcut(vertices.flat(), holes, 2)
        for (let corner = 0; corner < indices.length; corner += 3) {
          const a = vertices[indices[corner]!]!, b = vertices[indices[corner + 1]!]!, c = vertices[indices[corner + 2]!]!
          const signed = (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
          const scale = Math.max(1,...a.map(Math.abs),...b.map(Math.abs),...c.map(Math.abs))
          if (Math.abs(signed) <= Number.EPSILON*scale*scale*16) continue
          const [second,third] = signed > 0 ? [c,b] : [b,c]
          mesh.tri([a[0], 0, a[1]], [second[0], 0, second[1]], [third[0], 0, third[1]], palette.pavement)
        }
      }
    }
    else if (element.stair) staircase(mesh, element, dimensions)
    else if (element.shape?.kind === 'elliptical-plate') plate(mesh, dimensions.length, dimensions.width, dimensions.height)
    else if (element.shape) ellipticalRing(mesh, dimensions.length, dimensions.width, dimensions.height, element.shape.thickness, element.shape.kind === 'dome-shell')
    else route(mesh, element, dimensions.width, dimensions.height)
  }
  const positions: number[] = [], normals: number[] = [], materialIndices: number[] = []
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw)
  for (let index = 0; index < mesh.vertices.length; index += 7) {
    positions.push(...worldPoint([mesh.vertices[index]!, mesh.vertices[index + 2]!, mesh.vertices[index + 1]!], pose))
    const x = mesh.vertices[index + 3]!, y = mesh.vertices[index + 5]!
    normals.push(c * x - s * y, s * x + c * y, mesh.vertices[index + 4]!)
    materialIndices.push(element.material ? materialRoles.indexOf(element.material) : mesh.vertices[index + 6]!)
  }
  const linePositions: number[] = []
  for (let index = 0; index < mesh.lines.length; index += 3) linePositions.push(...worldPoint([mesh.lines[index]!, mesh.lines[index + 2]!, mesh.lines[index + 1]!], pose))
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < positions.length; index++) {
    const axis = index % 3
    min[axis] = Math.min(min[axis]!, positions[index]!)
    max[axis] = Math.max(max[axis]!, positions[index]!)
  }
  return { id: element.id, sourceElementId: element.id, label: element.label, kind: element.kind, levelId: element.levelId, positions, normals, materialIndices, materials: [...materialRoles], linePositions, bounds: { min, max } }
}
