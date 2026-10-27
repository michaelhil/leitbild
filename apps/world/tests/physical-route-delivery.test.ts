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
  for (let i = 0; i < mesh.positions.length; i += 9) {
    const triangle = [0, 3, 6].map(offset => key(mesh.positions.slice(i + offset, i + offset + 3)))
    for (let j = 0; j < 3; j++) { const edge = [triangle[j]!, triangle[(j + 1) % 3]!].sort().join('|'); edges.set(edge, (edges.get(edge) ?? 0) + 1) }
  }
  expect([...edges.values()].every(count => count === 2)).toBe(true)
  expect(mesh.positions.every(Number.isFinite)).toBe(true)
  for (let i = 0; i < mesh.normals.length; i += 3) expect(Math.hypot(...mesh.normals.slice(i, i + 3))).toBeCloseTo(1, 12)
  expect(physicalRouteTube([[0, 0, 0], [2, 0, 0], [4, 0, 0]], .2, .001).positions.length).toBeGreaterThan(mesh.positions.length)
})
