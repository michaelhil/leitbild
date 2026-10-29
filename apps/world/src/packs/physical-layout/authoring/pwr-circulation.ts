import polygonClipping from 'polygon-clipping'
import type { PackPhysicalScene, PhysicalSceneBounds } from '../../../core/packs/scene.ts'
import type { Source } from '../native/drafting/source.ts'
import { physicalObjectsBounds } from '../native/drafting/compile-scene.ts'
import { localPointAtAnchor } from '../native/campus/author-campus.ts'
import arrangement from '../pwr-campus.arrangement.json'
import { circulationFromPaths, circulationSurfaces } from './pavement.ts'

type Point = [number, number]
const ringFor = (bounds: PhysicalSceneBounds): Point[] => [
  [bounds.min[0], bounds.min[1]], [bounds.max[0], bounds.min[1]],
  [bounds.max[0], bounds.max[1]], [bounds.min[0], bounds.max[1]], [bounds.min[0], bounds.min[1]],
]
const area = (polygons: polygonClipping.MultiPolygon): number => polygons.reduce((total, polygon) => total + polygon.reduce((sum, ring, index) => sum + (index ? -1 : 1) * Math.abs(ring.reduce((value, point, at) => {
  const next = ring[(at + 1) % ring.length]!
  return value + point[0] * next[1] - next[0] * point[1]
}, 0) / 2), 0), 0)

/** Check building and represented unit-equipment footprints in the same canonical
 * east/north/up frame delivered to Plan and 3D, never in an old drawing chart.
 * This does not qualify vehicle clearances or campus electrical installations. */
export const pwrCampusPavementConflicts = (pavement: polygonClipping.MultiPolygon, unit: PackPhysicalScene, campus: PackPhysicalScene, tolerance: number): ReadonlyArray<string> => {
  const buildings = (scene: PackPhysicalScene) => (scene.scopes ?? []).filter(scope => scope.kind === 'building').map(scope => ({ id: scope.id, bounds: scope.bounds }))
  const unitEnvelopes = [...buildings(unit), ...unit.objects.filter(object => object.kind === 'equipment').map(object => ({ id: object.id, bounds: physicalObjectsBounds([object]) }))]
  const footprints = buildings(campus).map(envelope => ({ id: envelope.id, ring: ringFor(envelope.bounds) }))
  for (const member of arrangement.units) for (const envelope of unitEnvelopes) footprints.push({
    id: `${member.role}/${envelope.id}`,
    ring: ringFor(envelope.bounds).map(([x, y]) => {
      const projected = localPointAtAnchor(arrangement.siteAnchor as Point, member.anchor as Point, [x, y, 0])
      return [projected[0], projected[1]] as Point
    }),
  })
  return footprints.filter(footprint => area(polygonClipping.intersection(pavement, [footprint.ring])) > tolerance ** 2).map(footprint => footprint.id)
}

/** Approach existing unit service junctions orthogonally. A diagonal between
 * separately placed compounds crosses their southern buildings after a unit
 * drawing chart is normalized. Retain widths, turning radii and endpoints. */
export const authorPwrCampusCirculation = (source: Source, unit: PackPhysicalScene, campus: PackPhysicalScene): void => {
  const previous = source.circulation
  if (!previous) throw new Error('Campus circulation needs its retained topology and civil precision')
  const entrance = previous.nodes.filter(node => node.kind === 'entrance')
  if (entrance.length !== 1) throw new Error('Campus circulation needs its exact vehicle entrance')
  const roads = source.elements.filter(element => element.kind === 'road').map(element => {
    const specification = previous.edges.find(edge => edge.id.startsWith(`${element.id}/`))
    if (!specification || !element.path) throw new Error(`Campus road lacks its retained civil specification: ${element.id}`)
    let path: Point[] = element.path.map(point => [point[0], point[1]])
    if (element.id === 'road/unit-spine') path = path.flatMap((point, index) => index === 0 ? [point] : [[path[index - 1]![0], point[1]] as Point, point])
      .filter((point, index, points) => index === 0 || point[0] !== points[index - 1]![0] || point[1] !== points[index - 1]![1])
    const elevation = element.path[0]![2]
    if (element.path.some(point => point[2] !== elevation)) throw new Error(`Campus road must retain its common ground datum: ${element.id}`)
    element.path = path.map(([x, y]) => [x, y, elevation])
    return { id: element.id, path, width: specification.width, class: specification.class, turnRadius: specification.turnRadius }
  })
  const network = circulationFromPaths(roads, entrance[0]!.position, previous.surfaceTolerance)
  const surfaces = circulationSurfaces(network)
  const conflicts = pwrCampusPavementConflicts(surfaces.roads, unit, campus, network.surfaceTolerance)
  if (conflicts.length) throw new Error(`Campus pavement intersects canonical building/unit-equipment footprints: ${conflicts.join(', ')}`)
  source.circulation = network
  for (const [kind, surface] of Object.entries(surfaces)) {
    const pavement = source.elements.find(element => element.id === `pavement/${kind}`)
    if (!pavement || !surface.length) throw new Error(`Campus circulation lost its represented surface: ${kind}`)
    const points = surface.flat(2), xs = points.map(point => point[0]), ys = points.map(point => point[1])
    pavement.surface = surface
    pavement.dimensions = { ...pavement.dimensions!, length: Math.max(...xs) - Math.min(...xs), width: Math.max(...ys) - Math.min(...ys) }
  }
}
