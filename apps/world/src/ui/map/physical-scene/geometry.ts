import type { PackPhysicalScene, PhysicalSceneBounds, PhysicalSceneObject } from '../../../core/packs/scene.ts'
import earcut from 'earcut'
import { cross, dot, normalize, subtract, type Vector3 } from './math.ts'
import type { PhysicalSceneView } from './types.ts'

/** xyz, normal xyz, material-role index. Colours are assigned by the active token palette. */
type Vertex = [number, number, number, number, number, number, number]
export interface PhysicalMesh {
  /** Complementary view variants of an authored enclosure boundary. */
  readonly inspectionPart?: 'full' | 'cut'
  /** Earlier visible mesh keys that own this coincident display candidate. */
  readonly occludedBy?: readonly string[]
  /** Semantic Plan band; physical vertex heights are preserved. */
  readonly planPriority?: number
  readonly assetKey?: string
  readonly assetIndex?: number
  readonly key: string
  readonly object: PhysicalSceneObject
  readonly vertices: ReadonlyArray<number> | Float64Array
  readonly lines: ReadonlyArray<number> | Float64Array
  readonly lineMaterials?: ReadonlyArray<string>
  readonly lineStyles?: ReadonlyArray<'feature' | 'context' | 'section'>
  readonly levelId?: string
  readonly bounds: PhysicalSceneBounds
  readonly offset: Vector3
}
const position = (v: ArrayLike<number>): Vector3 => [v[0]!, v[1]!, v[2]!]
const pointKey = (p: Vector3): string => p.map(value => Math.round(value * 100_000)).join(',')
const vertexAt = (object: PhysicalSceneObject, index: number, normal: Vector3): Vertex => [
  object.positions[index * 3]!, object.positions[index * 3 + 1]!, object.positions[index * 3 + 2]!,
  object.normals?.[index * 3] ?? normal[0], object.normals?.[index * 3 + 1] ?? normal[1], object.normals?.[index * 3 + 2] ?? normal[2],
  object.materialIndices?.[index] ?? 0,
]

const clipPolygon = (vertices: Vertex[], height: number, above: boolean): Vertex[] => {
  if (!Number.isFinite(height)) return vertices
  const output: Vertex[] = []
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index]!, b = vertices[(index + 1) % vertices.length]!
    const insideA = above ? a[2] >= height : a[2] <= height
    const insideB = above ? b[2] >= height : b[2] <= height
    if (insideA) output.push(a)
    if (insideA !== insideB) {
      const ratio = (height - a[2]) / (b[2] - a[2])
      output.push(a.map((value, component) => component === 6 ? a[6] : value + (b[component]! - value) * ratio) as Vertex)
    }
  }
  return output
}

const sectionSegment = (triangle: Vertex[], height: number): [Vertex, Vertex] | null => {
  const intersections: Vertex[] = []
  for (let index = 0; index < 3; index++) {
    const a = triangle[index]!, b = triangle[(index + 1) % 3]!
    if ((a[2] < height && b[2] > height) || (a[2] > height && b[2] < height)) {
      const ratio = (height - a[2]) / (b[2] - a[2])
      intersections.push(a.map((value, component) => component === 6 ? a[6] : value + (b[component]! - value) * ratio) as Vertex)
    } else if (Math.abs(a[2] - height) < 1e-7) intersections.push(a)
  }
  const unique = [...new Map(intersections.map(v => [pointKey(position(v)), v])).values()]
  return unique.length === 2 ? [unique[0]!, unique[1]!] : null
}

const signedArea = (points: ReadonlyArray<Vertex>): number => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]!
  return sum + point[0] * next[1] - next[0] * point[1]
}, 0) / 2
const turn = (a: Vertex, b: Vertex, c: Vertex): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
const containsPoint = (loop: ReadonlyArray<Vertex>, point: Vertex): boolean => {
  let inside = false
  for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index++) {
    const a = loop[index]!, b = loop[previous]!
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** Horizontal wall cuts are inspection caps, never changes to authored geometry. */
const appendCaps = (segments: Array<[Vertex, Vertex]>, output: number[]): void => {
  const adjacent = new Map<string, Array<{ other: string; vertex: Vertex }>>()
  for (const [a, b] of segments) for (const [from, to] of [[a, b], [b, a]] as Array<[Vertex, Vertex]>) {
    const key = pointKey(position(from)), next = { other: pointKey(position(to)), vertex: to }
    const entries = adjacent.get(key) ?? []
    if (!entries.some(entry => entry.other === next.other)) entries.push(next)
    adjacent.set(key, entries)
  }
  const visited = new Set<string>()
  const loops: Vertex[][] = []
  for (const [start, entries] of adjacent) {
    if (visited.has(start) || entries.length !== 2) continue
    const loop: Vertex[] = []
    let previous = '', current = start
    do {
      visited.add(current)
      const choices = adjacent.get(current)
      if (!choices || choices.length !== 2) break
      const next = choices.find(choice => choice.other !== previous)!
      loop.push(next.vertex)
      previous = current; current = next.other
    } while (current !== start && !visited.has(current))
    if (current !== start || loop.length < 3) continue
    for (let index = loop.length - 1; index >= 0 && loop.length > 3; index--) if (Math.abs(turn(loop[(index + loop.length - 1) % loop.length]!, loop[index]!, loop[(index + 1) % loop.length]!)) < 1e-8) loop.splice(index, 1)
    loops.push(loop)
  }
  // Nested cut loops describe holes, not independent filled disks. Containment
  // shells, shafts and hollow walls must remain open at every inspection cut.
  const areas = loops.map(loop => Math.abs(signedArea(loop)))
  const parents = loops.map((loop, index) => {
    let parent = -1
    for (let other = 0; other < loops.length; other++) if (areas[other]! > areas[index]! && containsPoint(loops[other]!, loop[0]!) && (parent < 0 || areas[other]! < areas[parent]!)) parent = other
    return parent
  })
  const depth = (index: number): number => parents[index]! < 0 ? 0 : depth(parents[index]!) + 1
  for (let index = 0; index < loops.length; index++) {
    if (depth(index) % 2) continue
    const vertices = [...loops[index]!], holes: number[] = []
    for (let child = 0; child < loops.length; child++) if (parents[child] === index) { holes.push(vertices.length); vertices.push(...loops[child]!) }
    const indices = earcut(vertices.flatMap(vertex => [vertex[0], vertex[1]]), holes, 2)
    for (let corner = 0; corner < indices.length; corner += 3) {
      const triangle = indices.slice(corner, corner + 3).map(vertex => vertices[vertex]!)
      if (turn(triangle[0]!, triangle[1]!, triangle[2]!) < 0) triangle.reverse()
      for (const vertex of triangle) output.push(vertex[0], vertex[1], vertex[2], 0, 0, 1, vertex[6])
    }
  }
}

const outline = (vertices: ReadonlyArray<number>): number[] => {
  const edges = new Map<string, { a: Vector3; b: Vector3; normal: Vector3; crease: boolean; count: number }>()
  for (let index = 0; index < vertices.length; index += 21) {
    const a = position(vertices.slice(index, index + 3)), b = position(vertices.slice(index + 7, index + 10)), c = position(vertices.slice(index + 14, index + 17))
    const normal = normalize(cross(subtract(b, a), subtract(c, a)))
    for (const [from, to] of [[a, b], [b, c], [c, a]] as Array<[Vector3, Vector3]>) {
      const key = [pointKey(from), pointKey(to)].sort().join('/')
      const existing = edges.get(key)
      if (existing) { existing.count++; existing.crease ||= Math.abs(dot(existing.normal, normal)) < 0.85 }
      else edges.set(key, { a: from, b: to, normal, crease: false, count: 1 })
    }
  }
  return [...edges.values()].filter(edge => edge.count === 1 || edge.crease).flatMap(edge => [...edge.a, ...edge.b])
}

export const meshBounds = (vertices: ArrayLike<number>, stride = 7): PhysicalSceneBounds => {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < vertices.length; index += stride) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, vertices[index + axis]!); max[axis] = Math.max(max[axis]!, vertices[index + axis]!) }
  return { min, max }
}

export const buildVisibleMeshes = (scene: PackPhysicalScene, view: PhysicalSceneView): PhysicalMesh[] => {
  const levels = [...scene.levels].sort((a, b) => a.elevation - b.elevation)
  const selected = view.levelId === 'all' ? null : levels.find(level => level.id === view.levelId)
  if (view.levelId !== 'all' && !selected) throw new Error(`Physical scene ${scene.id} has no level ${view.levelId}`)
  const output: PhysicalMesh[] = []
  for (const object of scene.objects) {
    if (object.kind === 'space' || object.kind === 'opening' || object.kind === 'assembly' || (view.cutaway && object.kind === 'roof')) continue
    const bands = selected ? [selected] : view.separation > 0 && object.levelId !== 'site' ? levels : [null]
    for (const level of bands) {
      const authoredVolume = level ? object.inspectionLevels?.find(volume => volume.levelId === level.id) : undefined
      if (level && object.inspectionLevels && !authoredVolume) continue
      // A deck belongs to the floor it supports, even when its thickness extends below that elevation.
      if (level && object.kind === 'slab' && object.levelId !== 'site' && object.levelId !== level.id) continue
      // Outdoor containment is independent of indoor level views. A pylon or
      // site road must not be cut at an administration building's next floor.
      const clipLevel = object.levelId === 'site' ? null : level
      const next = clipLevel ? levels.find(candidate => candidate.elevation > clipLevel.elevation) : undefined
      let slabLow = Infinity
      if (authoredVolume && object.kind === 'slab' && object.levelId === clipLevel?.id) for (let index = 2; index < object.positions.length; index += 3) slabLow = Math.min(slabLow, object.positions[index]!)
      const low = clipLevel ? authoredVolume ? Math.min(authoredVolume.low, slabLow) : clipLevel.elevation - (object.kind === 'slab' && object.levelId === clipLevel.id ? 1 : 0.01) : -Infinity
      const upper = authoredVolume?.high ?? (next ? next.elevation - 0.001 : Infinity)
      const boundary = object.inspectionBoundary !== undefined && view.mode === '3d' && view.cutaway && object.levelId !== 'site'
      const firstVolume = boundary && !clipLevel ? object.inspectionLevels?.reduce((first, volume) => volume.low < first.low ? volume : first) : undefined
      const cutLevel = clipLevel ?? (boundary ? levels.find(level => level.id === firstVolume?.levelId) ?? levels[0]! : levels.at(-1)!)
      const cut = view.cutaway && (object.kind === 'wall' || object.inspectionBoundary !== undefined) && object.levelId !== 'site' ? authoredVolume ? authoredVolume.low + cutLevel.cutHeight - cutLevel.elevation : firstVolume ? firstVolume.low + cutLevel.cutHeight - cutLevel.elevation : cutLevel.cutHeight : Infinity
      // Camera-aware boundaries keep both exact representations resident. The
      // renderer chooses full rear walls or capped foreground walls; camera
      // movement never rebuilds source geometry or leaves a false section seam.
      const variants: ReadonlyArray<{ high: number; part?: 'full' | 'cut' }> = boundary && cut < upper ? [{ high: upper, part: 'full' }, { high: Math.min(upper, cut), part: 'cut' }] : [{ high: Math.min(upper, cut) }]
      for (const variant of variants) {
      const high = variant.high
      const vertices: number[] = [], segments: Array<[Vertex, Vertex]> = []
      const count = object.indices?.length ?? object.positions.length / 3
      for (let index = 0; index < count; index += 3) {
        const ids = [0, 1, 2].map(offset => object.indices?.[index + offset] ?? index + offset)
        const points = ids.map(id => position(object.positions.slice(id * 3, id * 3 + 3)))
        const normal = normalize(cross(subtract(points[1]!, points[0]!), subtract(points[2]!, points[0]!)))
        const triangle = ids.map(id => vertexAt(object, id, normal))
        let polygon = clipPolygon(clipPolygon(triangle, low, true), high, false)
        for (let corner = 1; corner < polygon.length - 1; corner++) vertices.push(...polygon[0]!, ...polygon[corner]!, ...polygon[corner + 1]!)
        if ((object.kind === 'wall' || object.inspectionBoundary !== undefined) && Number.isFinite(high)) { const segment = sectionSegment(triangle, high); if (segment) segments.push(segment) }
      }
      if (!vertices.length) continue
      appendCaps(segments, vertices)
      const lines = object.edgePolicy === 'none' || object.edgePolicy === 'authored' ? [] : outline(vertices)
      const lineMaterials = Array<string>(lines.length / 6).fill('line'), lineStyles: Array<'feature' | 'context' | 'section'> = Array(lines.length / 6).fill(object.kind === 'context' ? 'context' : 'feature')
      // A true horizontal section is viewing truth even when a family suppresses
      // illustrative edges; source floor/boolean partitions never become lines.
      if (object.edgePolicy !== undefined) for (const [a, b] of segments) { lines.push(...position(a), ...position(b)); lineMaterials.push('line'); lineStyles.push('section') }
      // Authored Plan is a complete stroke representation, not a second overlay
      // of the 3D feature set. Reuse features only when no Plan is authored.
      const features = object.edgePolicy === 'none' ? [] : object.featureLines ?? []
      const authoredLines = view.mode === '2d' ? object.planLines ?? features : features
      for (const line of authoredLines) {
        for (let index = 0; index < line.positions.length; index += 6) {
          let a = line.positions.slice(index, index + 3) as [number, number, number], b = line.positions.slice(index + 3, index + 6) as [number, number, number]
          let visible = true
          for (const [height, above] of [[low, true], [high, false]] as Array<[number, boolean]>) {
            if (!Number.isFinite(height)) continue
            const inA = above ? a[2] >= height : a[2] <= height, inB = above ? b[2] >= height : b[2] <= height
            if (!inA && !inB) { visible = false; break }
            if (inA !== inB) {
              const ratio = (height - a[2]) / (b[2] - a[2]), point = a.map((value, axis) => value + (b[axis]! - value) * ratio) as [number, number, number]
              if (inA) b = point; else a = point
            }
          }
          if (visible) { lines.push(...a, ...b); lineMaterials.push(line.material ?? 'line'); lineStyles.push(object.kind === 'context' ? 'context' : 'feature') }
        }
      }
      let planPriority: number | undefined
      if (view.mode === '2d') {
        // Plan uses its own projection/depth pass. Keep authored heights intact
        // and supply only semantic order; no physical-Z bias or material-ID rule.
        planPriority = object.kind === 'slab' || object.kind === 'pavement' ? 0 : object.kind === 'context' ? 1 : object.kind === 'wall' ? 2 : object.kind === 'support' || object.kind === 'stair' ? 3 : object.kind === 'equipment' ? 4 : object.kind === 'pipe' || object.kind === 'riser' ? 5 : object.kind === 'door' ? 6 : object.kind === 'roof' ? 8 : 3
      }
      const offset: Vector3 = [0, 0, view.mode === '3d' && level && !selected ? levels.indexOf(level) * view.separation : 0]
      output.push({ ...(variant.part === undefined ? {} : { inspectionPart: variant.part }), ...(planPriority === undefined ? {} : { planPriority }), key: `${object.id}/${level?.id ?? 'all'}${variant.part === undefined ? '' : `/inspection-${variant.part}`}`, object, vertices: Float64Array.from(vertices), lines: Float64Array.from(lines), lineMaterials, lineStyles, levelId: level?.id ?? object.levelId, bounds: meshBounds(vertices), offset })
      }
    }
  }
  return output
}
