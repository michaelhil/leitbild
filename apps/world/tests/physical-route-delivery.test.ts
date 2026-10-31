import { expect, test } from 'bun:test'
import type { PhysicalSceneObject } from '../src/core/packs/scene.ts'
import { compilePhysicalRoutes, physicalRouteTube, solvePhysicalRoutingNetwork } from '../src/packs/physical-layout/native/routing/compile.ts'
import type { Source } from '../src/packs/physical-layout/native/architecture/source.ts'
import type { PhysicalRouting } from '../src/packs/physical-layout/native/routing/source.ts'

const source: Source & { routing?: PhysicalRouting } = {
  id: 'different-plant', title: 'A different plant', units: 'm', axes: 'Z-up', origin: [0, 0, 0], rootScope: { id: 'unit', label: 'Unit', kind: 'unit' }, evidence: { accuracy: 'illustrative', origin: 'Routing regression fixture only' },
  levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 1.2 }], types: [],
  elements: [{ id: 'pump', label: 'Pump', kind: 'equipment', equipmentKind: 'pump', levelId: 'floor', disposition: 'installed', pose: { position: [1, 1, 0], yaw: 0 }, dimensions: { length: 2, width: 2, height: 2 } }, { id: 'tank', label: 'Tank', kind: 'equipment', equipmentKind: 'tank', levelId: 'floor', disposition: 'installed', pose: { position: [8, 1, 0], yaw: 0 }, dimensions: { length: 2, width: 2, height: 2 } }],
  routing: { geometryTolerance: .01, obstacleElementIds: ['pump', 'tank'], terminals: [{ id: 'out', elementId: 'pump', subjectId: 'pump', port: 'outlet', local: [2, 1, 1], outward: [1, 0, 0] }, { id: 'in', elementId: 'tank', subjectId: 'tank', port: 'inlet', local: [0, 1, 1], outward: [-1, 0, 0] }], connections: [{ id: 'physical/supply', graphConnectionId: 'supply', from: 'out', to: 'in', kind: 'pipe', diameter: .2, clearance: .1, bendRadius: .4, envelope: { min: [0, 0, 0], max: [12, 10, 10] }, material: 'pipe', layerId: 'piping' }] },
}
const objects: PhysicalSceneObject[] = source.elements.map(element => ({ id: element.id, label: element.label, kind: 'equipment', levelId: 'floor', scopeIds: ['unit'], subjectIds: [element.id], positions: [], bounds: { min: element.pose.position, max: [element.pose.position[0] + 2, element.pose.position[1] + 2, element.pose.position[2] + 2] } }))
test('authoring persists a solved centerline; cold delivery validates it and binds actual graph connection identity', () => {
  expect(() => compilePhysicalRoutes(source, objects)).toThrow('no accepted authoring solution')
  const solved = { ...source, routing: solvePhysicalRoutingNetwork(source, objects)! }, before = JSON.stringify(solved)
  const routes = compilePhysicalRoutes(solved, objects), route = routes[0]!
  expect(route.object.subjectIds).toEqual(['supply']); expect(route.object.kind).toBe('pipe'); expect(route.object.layerId).toBe('piping')
  expect(route.centerline[0]).toEqual([3, 2, 1]); expect(route.centerline.at(-1)).toEqual([8, 2, 1]); expect(route.solution.visited).toBe(0)
  expect(route.object.positions.length).toBeGreaterThan(0); expect(route.object.normals!.length).toBe(route.object.positions.length)
  expect(JSON.stringify(solved)).toBe(before)
  const moved = structuredClone(solved); moved.elements[1]!.pose.position[1] += 1
  expect(() => compilePhysicalRoutes(moved, objects)).toThrow()
})
test('a continuous pipe sweep has only terminal caps and no open internal seams; tighter authored accuracy refines geometry', () => {
  const mesh = physicalRouteTube([[0, 0, 0], [2, 0, 0], [4, 0, 0]], .2, .01), edges = new Map<string, number>()
  const key = (point: number[]) => point.map(v => Object.is(v, -0) ? 0 : v).join(',')
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const triangle = mesh.indices.slice(i, i + 3).map(index => key(mesh.positions.slice(index * 3, index * 3 + 3)))
    for (let j = 0; j < 3; j++) { const edge = [triangle[j]!, triangle[(j + 1) % 3]!].sort().join('|'); edges.set(edge, (edges.get(edge) ?? 0) + 1) }
  }
  expect([...edges.values()].every(count => count === 2)).toBe(true)
  expect(mesh.positions.every(Number.isFinite)).toBe(true)
  for (let i = 0; i < mesh.normals.length; i += 3) expect(Math.hypot(...mesh.normals.slice(i, i + 3))).toBeCloseTo(1, 12)
  expect(physicalRouteTube([[0, 0, 0], [2, 0, 0], [4, 0, 0]], .2, .001).positions.length).toBeGreaterThan(mesh.positions.length)
})

test('analytic circular tangents give exact sweep frames and outer-torus chord accuracy', async () => {
  const { roundedPhysicalRouteSamples, roundedPhysicalRoute } = await import('../src/packs/physical-layout/native/routing/round.ts')
  const controls = [[0, 0, 0], [5, 0, 0], [5, 5, 0]] as const, radius = 1, tubeRadius = .8, tolerance = .01
  const samples = roundedPhysicalRouteSamples(controls, radius, tolerance / 2, radius + tubeRadius)
  expect(roundedPhysicalRouteSamples(controls, radius, tolerance / 2).points).toEqual(roundedPhysicalRoute(controls, radius, tolerance / 2))
  expect(samples.points.length).toBeGreaterThanOrEqual(roundedPhysicalRoute(controls, radius, tolerance / 2).length)
  const start = samples.points.findIndex(p => p[0] === 4 && p[1] === 0), end = samples.points.findIndex(p => p[0] === 5 && p[1] === 1)
  expect(samples.tangents[start]).toEqual([1, 0, 0]); expect(samples.tangents[end]).toEqual([0, 1, 0])
  for (let i = start; i <= end; i++) {
    const point = samples.points[i]!, tangent = samples.tangents[i]!
    expect(Math.hypot(...tangent)).toBeCloseTo(1, 13)
    expect((point[0] - 4) * tangent[0] + (point[1] - 1) * tangent[1]).toBeCloseTo(0, 13)
  }
  const mesh = physicalRouteTube(samples.points, tubeRadius, tolerance / 2, samples.tangents), sides = (mesh.positions.length / 3 - 2) / (samples.points.length + 2)
  expect(Number.isInteger(sides)).toBe(true)
  for (let ring = 0; ring < samples.points.length; ring++) for (let side = 0; side < sides; side++) {
    const normal = mesh.normals.slice((ring * sides + side) * 3, (ring * sides + side + 1) * 3), tangent = samples.tangents[ring]!
    expect(normal.reduce((sum, n, axis) => sum + n * tangent[axis]!, 0)).toBeCloseTo(0, 12)
    expect(Math.hypot(...normal)).toBeCloseTo(1, 12)
  }
  let maxError = 0
  for (let at = start * sides * 6; at < end * sides * 6; at += 3) {
    const triangle = mesh.indices.slice(at, at + 3).map(i => mesh.positions.slice(i * 3, i * 3 + 3))
    for (const weights of [[1, 0, 0], [.5, .5, 0], [.5, 0, .5], [0, .5, .5], [1 / 3, 1 / 3, 1 / 3]]) {
      const point = [0, 1, 2].map(axis => triangle.reduce((sum, vertex, i) => sum + vertex[axis]! * weights[i]!, 0))
      const distance = Math.hypot(Math.hypot(point[0]! - 4, point[1]! - 1) - radius, point[2]!)
      maxError = Math.max(maxError, Math.abs(distance - tubeRadius))
    }
  }
  expect(maxError).toBeLessThanOrEqual(tolerance)
  expect(() => physicalRouteTube(samples.points, tubeRadius, tolerance / 2, [[1, 0, 0]])).toThrow('must match')
})
