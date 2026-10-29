import { describe, expect, test } from 'bun:test'
import polygonClipping from 'polygon-clipping'
import previousCampusSource from '../src/packs/physical-layout/pwr-campus-connected.source.json'
import previousCampusBindings from '../src/packs/physical-layout/pwr-campus-connected.bindings.json'
import unitSource from '../src/packs/physical-layout/pwr-full-unit-manifold.source.json'
import unitBindings from '../src/packs/physical-layout/pwr-full-unit-manifold.bindings.json'
import savedCampusSource from '../src/packs/physical-layout/pwr-campus-manifold.source.json'
import unitDesign from '../src/packs/physical-layout/pwr-full-unit-manifold.design.json'
import previousCampusDesign from '../src/packs/physical-layout/pwr-campus-connected.design.json'
import { compilePhysicalScene } from '../src/packs/physical-layout/native/drafting/compile-scene.ts'
import { physicalSourceSchema } from '../src/packs/physical-layout/native/drafting/source.ts'
import { createPwrManifoldCampusArtifacts } from '../src/packs/physical-layout/authoring/pwr-manifolds.ts'
import { pwrCampusPavementConflicts } from '../src/packs/physical-layout/authoring/pwr-circulation.ts'
import type { PackPhysicalScene, PhysicalSceneBounds } from '../src/core/packs/scene.ts'

const compile = (raw: unknown, bindings: typeof unitBindings, bounds: PhysicalSceneBounds) => {
  const source = physicalSourceSchema.parse(raw)
  return compilePhysicalScene('clearance-test', { source, bindings, design: { digest: 'clearance-test' }, owner: { objectId: 'clearance-test' }, placement: { anchor: [0, 0], bearing: 0 }, bounds })
}
const unit = compile(unitSource, unitBindings, unitDesign.bounds as PhysicalSceneBounds)
const previous = compile(previousCampusSource, previousCampusBindings, previousCampusDesign.bounds as PhysicalSceneBounds)
const current = createPwrManifoldCampusArtifacts()
const campus = compile(current.source, current.bindings, previousCampusDesign.bounds as PhysicalSceneBounds)
const pavement = current.source.elements.find(element => element.id === 'pavement/roads')!.surface!

type V3 = [number, number, number]
// Independent geometric oracle: actual mesh triangles clipped to the road slab,
// rather than an equipment AABB containing overhead crossarms and open air.
const clipHeight = (polygon: V3[], height: number, lower: boolean): V3[] => polygon.flatMap((a, index) => {
  const b = polygon[(index + 1) % polygon.length]!, insideA = lower ? a[2] >= height : a[2] <= height, insideB = lower ? b[2] >= height : b[2] <= height
  if (insideA === insideB) return insideA ? [a] : []
  const t = (height - a[2]) / (b[2] - a[2]), crossing = a.map((value, axis) => value + (b[axis]! - value) * t) as V3
  return insideA ? [a, crossing] : [crossing]
})
const groundTriangleIntersections = (surface: polygonClipping.MultiPolygon): number => {
  const support = campus.objects.find(object => object.id === 'pylon/tegneby-double')!, road = current.source.elements.find(element => element.id === 'pavement/roads')!
  const low = road.pose.position[2], high = low + road.dimensions!.height
  let count = 0
  for (let index = 0; index < support.positions.length; index += 9) {
    const triangle = [0, 1, 2].map(vertex => support.positions.slice(index + vertex * 3, index + vertex * 3 + 3) as V3)
    const slab = clipHeight(clipHeight(triangle, low, true), high, false)
    if (slab.length < 3) continue
    const ring = slab.map(point => [point[0], point[1]] as [number, number]); ring.push(ring[0]!)
    const intersection = polygonClipping.intersection(surface, [ring])
    if (intersection.some(polygon => polygon.some(ring => Math.abs(ring.reduce((sum, point, at) => { const next = ring[(at + 1) % ring.length]!; return sum + point[0] * next[1] - next[0] * point[1] }, 0)) > 0))) count++
  }
  return count
}

describe('current-campus civil clearance in the actual delivered physical frame', () => {
  test('the previous diagonal reproduces the reported diesel and fuel-service building overlaps', () => {
    expect(unitSource.northAxis).toBe('negative-y')
    const old = physicalSourceSchema.parse(previousCampusSource)
    const conflicts = pwrCampusPavementConflicts(old.elements.find(element => element.id === 'pavement/roads')!.surface!, unit, previous, old.circulation!.surfaceTolerance)
    expect(conflicts.filter(id => id.includes('/building/')).sort()).toEqual(['unit-2', 'unit-3', 'unit-4'].flatMap(role => ['diesel-a', 'diesel-b', 'fuel-service'].map(building => `${role}/building/${building}`)).sort())
  })

  test('regenerated retained source clears building and all represented unit/campus equipment envelopes without altering unit geometry', () => {
    expect(JSON.stringify(current.source)).toBe(JSON.stringify(physicalSourceSchema.parse(savedCampusSource)))
    expect(pavement).toHaveLength(1)
    expect(pwrCampusPavementConflicts(pavement, unit, campus, current.source.circulation!.surfaceTolerance)).toEqual([])
    expect(unit.objects.some(object => object.id === 'building/diesel-a')).toBe(false) // Buildings are scope envelopes, not filled renderer boxes.
    expect(unit.scopes?.some(scope => scope.id === 'building/diesel-a')).toBe(true)
    const first = pavement[0]![0]![0]!
    const building = campus.scopes!.find(scope => scope.kind === 'building')!
    const planted: PackPhysicalScene = { ...campus, scopes: [...campus.scopes!, { ...building, id: 'future-building', bounds: { min: [first[0] - 1, first[1] - 1, 0], max: [first[0] + 1, first[1] + 1, 4] } }] }
    expect(pwrCampusPavementConflicts(pavement, unit, planted, current.source.circulation!.surfaceTolerance)).toContain('future-building')
  })

  test('the local shared approach clears actual pylon ground members, not just an overhead AABB', () => {
    const old = physicalSourceSchema.parse(previousCampusSource), before = old.elements.find(element => element.id === 'pavement/roads')!.surface!
    expect(groundTriangleIntersections(before)).toBeGreaterThan(0)
    expect(groundTriangleIntersections(pavement)).toBe(0)
    const oldWest = old.elements.find(element => element.id === 'road/unit-3-west-service')!.path!
    const newWest = current.source.elements.find(element => element.id === 'road/unit-3-west-service')!.path!
    expect(newWest[0]).toEqual(oldWest[0]); expect(newWest.at(-1)).toEqual(oldWest.at(-1))
    for (const road of current.source.elements.filter(element => element.kind === 'road' && element.id !== 'road/unit-spine' && element.id !== 'road/unit-3-west-service')) expect(road).toEqual(old.elements.find(element => element.id === road.id)!)
  })

  test('all existing vehicle junctions remain connected and every road retains its civil width and turn radius', () => {
    const network = current.source.circulation!, original = physicalSourceSchema.parse(previousCampusSource)
    const vehicle = network.edges.filter(edge => edge.class !== 'pedestrian')
    const reachable = new Set([network.nodes.find(node => node.kind === 'entrance')!.id])
    let changed = true
    while (changed) {
      changed = false
      for (const edge of vehicle) if (reachable.has(edge.from) || reachable.has(edge.to)) {
        if (!reachable.has(edge.from) || !reachable.has(edge.to)) changed = true
        reachable.add(edge.from); reachable.add(edge.to)
      }
    }
    expect(vehicle.every(edge => reachable.has(edge.from) && reachable.has(edge.to))).toBe(true)
    const oldSpine = original.elements.find(element => element.id === 'road/unit-spine')!.path!
    const newSpine = current.source.elements.find(element => element.id === 'road/unit-spine')!.path!
    for (const point of oldSpine) expect(newSpine).toContainEqual(point)
    expect(newSpine.slice(1).every((point, index) => point[0] === newSpine[index]![0] || point[1] === newSpine[index]![1])).toBe(true)
    for (const road of current.source.elements.filter(element => element.kind === 'road')) {
      const before = original.circulation!.edges.find(edge => edge.id.startsWith(`${road.id}/`))!
      expect(network.edges.filter(edge => edge.id.startsWith(`${road.id}/`)).every(edge => edge.width === before.width && edge.turnRadius === before.turnRadius && edge.class === before.class)).toBe(true)
    }
  })

  test('Plan and 3D both compile the revised joined pavement rather than applying a display mask', () => {
    const rendered = campus.objects.find(object => object.id === 'pavement/roads')!
    expect(rendered.kind).toBe('pavement')
    expect(rendered.edgePolicy).toBe('none')
    expect(campus.planDrawing!.views.some(view => view.primitives.some(primitive => primitive.occurrenceId === rendered.id && primitive.kind === 'path' && primitive.fill === 'pavement'))).toBe(true)
    expect(rendered.positions.length).toBeGreaterThan(0)
    expect(current.source.elements.find(element => element.id === 'road/unit-spine')!.path).not.toEqual(previousCampusSource.elements.find(element => element.id === 'road/unit-spine')!.path)
  })
})
