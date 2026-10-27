import type { PackPhysicalScene, PhysicalSceneObject } from '../../../../core/packs/scene.ts'
import type { PhysicalPlanDrawing, PhysicalPlanPrimitive } from '../../../../core/packs/plan-drawing.ts'
import { elementWorld, type Source as ArchitectureSource, type V3 } from '../architecture/source.ts'
import { routePhysicalConnection, roundedPhysicalRoute, validatePhysicalConnectionRoute, type PhysicalRoutedPath, type PhysicalRouteRequest } from './route.ts'
import type { PhysicalRouting, RoutePoint, RoutingTerminal } from './source.ts'

type Source = ArchitectureSource & { readonly routing?: PhysicalRouting }
export interface CompiledPhysicalRoute { readonly object: PhysicalSceneObject; readonly centerline: ReadonlyArray<RoutePoint>; readonly solution: PhysicalRoutedPath }
const subtract = (a: RoutePoint, b: RoutePoint): V3 => a.map((v, i) => v - b[i]!) as V3
const norm = (v: RoutePoint): V3 => { const length = Math.hypot(...v); if (!length) throw new Error('A route sweep requires a nonzero tangent'); return v.map(n => n / length) as V3 }
const cross = (a: RoutePoint, b: RoutePoint): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: RoutePoint, b: RoutePoint) => a.reduce((sum, v, i) => sum + v * b[i]!, 0)
const perpendicular = (tangent: RoutePoint): V3 => {
  const least = [0, 1, 2].reduce((best, axis) => Math.abs(tangent[axis]!) < Math.abs(tangent[best]!) ? axis : best, 0), axis: V3 = [0, 0, 0]
  axis[least] = 1; return norm(cross(tangent, axis))
}
const extent = (points: ReadonlyArray<RoutePoint>, padding: number) => ({ min: [0, 1, 2].map(axis => Math.min(...points.map(p => p[axis]!)) - padding) as V3, max: [0, 1, 2].map(axis => Math.max(...points.map(p => p[axis]!)) + padding) as V3 })

/** Continuous watertight sweep: shared rings and smooth normals, capped only at
 * terminals. Accuracy derives from the authored chord tolerance, not facet caps. */
export const physicalRouteTube = (points: ReadonlyArray<RoutePoint>, radius: number, tolerance: number) => {
  if (points.length < 2 || !Number.isFinite(radius) || !Number.isFinite(tolerance) || !(radius > 0) || !(tolerance > 0) || points.some(point => point.some(v => !Number.isFinite(v)))) throw new Error('A route sweep needs a finite path, radius and geometric tolerance')
  // asin avoids catastrophic cancellation in acos(1-tolerance/radius).
  const count = Math.max(3, Math.ceil(Math.PI / (2 * Math.asin(Math.sqrt(Math.min(1, tolerance / (2 * radius)))))))
  if (!Number.isSafeInteger(count)) throw new Error('Requested sweep accuracy exceeds representable geometric precision')
  const tangents = points.map((p, i) => norm(i === 0 ? subtract(points[1]!, p) : i === points.length - 1 ? subtract(p, points[i - 1]!) : norm(subtract(p, points[i - 1]!)).map((v, axis) => v + norm(subtract(points[i + 1]!, p))[axis]!) as V3))
  let u: V3 = perpendicular(tangents[0]!)
  const rings = points.map((center, index) => {
    const tangent = tangents[index]!, projected = u.map((value, axis) => value - tangent[axis]! * dot(u, tangent)) as V3
    u = Math.hypot(...projected) > Number.EPSILON ? norm(projected) : perpendicular(tangent)
    const v = cross(tangent, u)
    return Array.from({ length: count }, (_, side) => {
      const angle = side * 2 * Math.PI / count, normal = u.map((n, axis) => n * Math.cos(angle) + v[axis]! * Math.sin(angle)) as V3
      return { point: center.map((n, axis) => n + radius * normal[axis]!) as V3, normal }
    })
  })
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], lines: number[] = []
  const vertex = (p: RoutePoint, n: RoutePoint) => { const index = positions.length / 3; positions.push(...p); normals.push(...n); return index }
  for (const ring of rings) for (const sample of ring) vertex(sample.point, sample.normal)
  for (let ring = 1; ring < rings.length; ring++) for (let side = 0; side < count; side++) {
    const a = (ring - 1) * count + side, b = (ring - 1) * count + (side + 1) % count, c = ring * count + (side + 1) % count, d = ring * count + side
    indices.push(a, b, c, a, c, d)
  }
  for (const end of [0, rings.length - 1]) {
    const normal = tangents[end]!.map(v => end ? v : -v) as V3, center = vertex(points[end]!, normal), rim = positions.length / 3
    for (const sample of rings[end]!) vertex(sample.point, normal)
    for (let side = 0; side < count; side++) {
      const a = rim + side, b = rim + (side + 1) % count
      indices.push(center, end ? a : b, end ? b : a); lines.push(...rings[end]![side]!.point, ...rings[end]![(side + 1) % count]!.point)
    }
  }
  return { positions, normals, indices, featureLines: [{ positions: lines, material: 'line' }] }
}

/** Solve and validate in the SAME authoring frame. Persisting a local path as
 * absolute then subtracting the origin would perturb exact clearance faces. */
const routingRequests = (source: Source, objects: ReadonlyArray<PhysicalSceneObject>) => {
  const network = source.routing; if (!network) return []
  const elements = new Map(source.elements.map(e => [e.id, e])), roster = new Map(objects.map(object => [object.id, object]))
  const terminals = new Map(network.terminals.map(terminal => [terminal.id, terminal]))
  const obstacleIds = new Set(network.obstacleElementIds)
  const endpoint = (terminal: RoutingTerminal) => {
    const element = elements.get(terminal.elementId); if (!element) throw new Error(`Unknown routing occurrence: ${terminal.elementId}`)
    const pose = elementWorld(source, element), c = Math.cos(pose.yaw), s = Math.sin(pose.yaw), local = terminal.local, outward = terminal.outward
    return { point: [pose.position[0] + c * local[0] - s * local[1], pose.position[1] + s * local[0] + c * local[1], pose.position[2] + local[2]] as V3, outward: [c * outward[0] - s * outward[1], s * outward[0] + c * outward[1], outward[2]] as V3, ...(obstacleIds.has(terminal.elementId) ? { obstacleId: terminal.elementId } : {}) }
  }
  const obstacles = network.obstacleElementIds.map(id => { const object = roster.get(id); if (!object?.bounds) throw new Error(`Routing obstacle has no physical solid: ${id}`); return { id, min: object.bounds.min.map((value, axis) => value + source.origin[axis]!) as V3, max: object.bounds.max.map((value, axis) => value + source.origin[axis]!) as V3 } })
  return network.connections.map(connection => {
    const fromTerminal = terminals.get(connection.from)!, toTerminal = terminals.get(connection.to)!, from = endpoint(fromTerminal), to = endpoint(toTerminal)
    const request: PhysicalRouteRequest = { id: connection.id, from, to, radius: connection.diameter / 2, clearance: connection.clearance, bendRadius: connection.bendRadius, obstacles, envelope: connection.envelope, ...(connection.via ? { via: connection.via } : {}) }
    return { connection, fromTerminal, toTerminal, request }
  })
}

/** Authoring operation only. Persist the result in the exact source revision;
 * no map load or live sample invokes the search engine. */
export const solvePhysicalRoutingNetwork = (source: Source, objects: ReadonlyArray<PhysicalSceneObject>): PhysicalRouting | undefined => {
  if (!source.routing) return undefined
  return { ...source.routing, connections: routingRequests(source, objects).map(({ connection, request }) => ({ ...connection, solution: routePhysicalConnection(request).points.map(point => [...point] as V3) })) }
}

/** Retained delivery validates accepted routes and generates one shared asset.
 * A missing/stale solution is an explicit source error, never a browser search. */
export const compilePhysicalRoutes = (source: Source, objects: ReadonlyArray<PhysicalSceneObject>): CompiledPhysicalRoute[] => {
  const network = source.routing; if (!network) return []
  const roster = new Map(objects.map(object => [object.id, object]))
  return routingRequests(source, objects).map(({ connection, fromTerminal, toTerminal, request }) => {
    if (!connection.solution) throw new Error(`Physical route has no accepted authoring solution: ${connection.id}`)
    const points = connection.solution
    const validation = validatePhysicalConnectionRoute(request, points)
    const solution: PhysicalRoutedPath = { id: connection.id, points, ...validation, visited: 0 }
    const centerline = roundedPhysicalRoute(solution.points, connection.bendRadius, network.geometryTolerance / 2).map(point => subtract(point, source.origin)), radius = connection.diameter / 2, geometry = physicalRouteTube(centerline, radius, network.geometryTolerance / 2), bounds = extent(centerline, radius)
    const fromObject = roster.get(fromTerminal.elementId)!, toObject = roster.get(toTerminal.elementId)!
    const outside = fromObject.levelId === 'site' && toObject.levelId === 'site'
    const scopes = new Set([source.rootScope.id, ...(fromObject.scopeIds ?? []), ...(toObject.scopeIds ?? [])])
    const volumes = new Map<string, { levelId: string; low: number; high: number }>()
    for (const object of [fromObject, toObject]) for (const floor of object.inspectionLevels ?? []) { const previous = volumes.get(floor.levelId); volumes.set(floor.levelId, { levelId: floor.levelId, low: Math.min(previous?.low ?? Infinity, floor.low), high: Math.max(previous?.high ?? -Infinity, floor.high) }) }
    if (!volumes.size) for (let i = 0; i < source.levels.length; i++) { const floor = source.levels[i]!; volumes.set(floor.id, { levelId: floor.id, low: floor.elevation - source.origin[2], high: (source.levels[i + 1]?.elevation ?? bounds.max[2] + source.origin[2] + radius) - source.origin[2] }) }
    const inspectionLevels = [...volumes.values()].filter(floor => bounds.max[2] > floor.low && bounds.min[2] < floor.high), levelIds = inspectionLevels.map(floor => floor.levelId)
    if (!outside && !levelIds.length) throw new Error(`Physical route has no admitted floor volume: ${connection.id}`)
    return { solution, centerline, object: { id: connection.id, label: `${connection.kind === 'pipe' ? 'Pipe' : 'Electrical connection'} · ${connection.graphConnectionId}`, kind: connection.kind === 'pipe' ? 'pipe' : 'conductor', levelId: outside ? 'site' : levelIds[0]!, ...(outside ? {} : { levelIds, inspectionLevels }), scopeIds: [...scopes], subjectIds: [connection.graphConnectionId], material: connection.material, layerId: connection.layerId, positions: geometry.positions, indices: geometry.indices, normals: geometry.normals, featureLines: geometry.featureLines, bounds, edgePolicy: 'authored' as const, planDisplay: 'projection' as const, clipToScope: true as const, spatialPath: { points: centerline.map(point => [...point] as V3), radius } } }
  })
}

export const appendPhysicalRouteDrawing = (scene: PackPhysicalScene, drawing: PhysicalPlanDrawing, routes: ReadonlyArray<CompiledPhysicalRoute>): PhysicalPlanDrawing => ({ views: drawing.views.map(view => {
  const floor = scene.levels.find(floor => floor.id === view.levelId)!, primitives: PhysicalPlanPrimitive[] = []
  for (const route of routes) {
    const volume = route.object.levelId === 'site' ? { low: -Infinity, high: Infinity } : route.object.inspectionLevels!.find(volume => volume.levelId === view.levelId); if (!volume) continue
    const groups = new Map<boolean, { commands: Array<['M' | 'L', number, number]>; points: RoutePoint[] }>()
    const append = (a: RoutePoint, b: RoutePoint, above: boolean) => {
      let group = groups.get(above); if (!group) { group = { commands: [], points: [] }; groups.set(above, group) }
      const last = group.points.at(-1)
      if (!last || !last.every((v, axis) => v === a[axis])) group.commands.push(['M', a[0], a[1]])
      group.commands.push(['L', b[0], b[1]]); group.points.push(a, b)
    }
    for (let i = 1; i < route.centerline.length; i++) {
      const a = route.centerline[i - 1]!, b = route.centerline[i]!, delta = b[2] - a[2]
      let low = 0, high = 1
      if (!delta) { if (a[2] < volume.low || a[2] >= volume.high) continue }
      else { const x = (volume.low - a[2]) / delta, y = (volume.high - a[2]) / delta; low = Math.max(0, Math.min(x, y)); high = Math.min(1, Math.max(x, y)); if (low >= high) continue }
      const fractions = [low, ...(delta && (floor.cutHeight - a[2]) / delta > low && (floor.cutHeight - a[2]) / delta < high ? [(floor.cutHeight - a[2]) / delta] : []), high]
      for (let part = 1; part < fractions.length; part++) {
        const p = a.map((v, axis) => v + (b[axis]! - v) * fractions[part - 1]!) as V3, q = a.map((v, axis) => v + (b[axis]! - v) * fractions[part]!) as V3
        append(p, q, route.object.levelId !== 'site' && (p[2] + q[2]) / 2 > floor.cutHeight)
      }
    }
    // One cached path per depiction, not a separate draw for every curve chord.
    for (const [above, group] of groups) {
      const bounds = extent(group.points, .04)
      primitives.push({ id: `routing/${route.object.id}/${above ? 'above' : 'projection'}`, kind: 'path', scopeIds: route.object.scopeIds!, occurrenceId: route.object.id, layerId: route.object.layerId!, depiction: above ? 'above' : 'projection', commands: group.commands, stroke: route.object.material!, width: .08, ...(above ? { dash: [.5, .2] } : {}), bounds: { min: [bounds.min[0], bounds.min[1]], max: [bounds.max[0], bounds.max[1]] } })
    }
  }
  const all = [...view.primitives, ...primitives], bounds = { min: [Math.min(view.bounds.min[0], ...primitives.map(p => p.bounds.min[0])), Math.min(view.bounds.min[1], ...primitives.map(p => p.bounds.min[1]))] as [number, number], max: [Math.max(view.bounds.max[0], ...primitives.map(p => p.bounds.max[0])), Math.max(view.bounds.max[1], ...primitives.map(p => p.bounds.max[1]))] as [number, number] }
  return { ...view, bounds, primitives: all }
}) })
