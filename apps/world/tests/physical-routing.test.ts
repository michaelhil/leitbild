import { expect, test } from 'bun:test'
import { physicalRouteIntersects, routePhysicalConnection, roundedPhysicalRoute, type PhysicalRouteRequest } from '../src/packs/physical-layout/native/routing/route.ts'
import { physicalRoutingSchema } from '../src/packs/physical-layout/native/routing/source.ts'

const request: PhysicalRouteRequest = {
  id: 'supply', from: { point: [1, 2, 2], outward: [1, 0, 0] }, to: { point: [9, 2, 2], outward: [-1, 0, 0] },
  envelope: { min: [0, 0, 0], max: [10, 10, 10] }, radius: .1, clearance: .1, bendRadius: .4,
  obstacles: [{ id: 'wall', min: [4, 0, 0], max: [6, 10, 5] }],
}
test('3D routing rises over a wall that blocks every plan-only path, with conservative bend clearance', () => {
  const result = routePhysicalConnection(request)
  expect(result.points[0]).toEqual(request.from.point); expect(result.points.at(-1)).toEqual(request.to.point)
  expect(Math.max(...result.points.map(p => p[2]))).toBeGreaterThanOrEqual(5.6)
  const rounded = roundedPhysicalRoute(result.points, request.bendRadius, .005)
  const clearance = { min: [3.8, -.2, -.2] as const, max: [6.2, 10.2, 5.2] as const }
  for (let i = 1; i < rounded.length; i++) expect(physicalRouteIntersects(rounded[i - 1]!, rounded[i]!, clearance)).toBe(false)
  expect(routePhysicalConnection(request)).toEqual(result)
})
test('routing refuses a completely sealed authored volume instead of drawing through it', () => {
  expect(() => routePhysicalConnection({ ...request, obstacles: [{ id: 'sealed', min: [4, -1, -1], max: [6, 11, 11] }] })).toThrow('No clearance-safe 3D route')
})
test('terminal escape exempts only its own equipment and preserves the specified port direction', () => {
  const own = { id: 'pump', min: [0, 1, 1] as const, max: [2, 3, 3] as const }
  const result = routePhysicalConnection({ ...request, from: { point: [2, 2, 2], outward: [1, 0, 0], obstacleId: 'pump' }, obstacles: [own] })
  expect(result.points[1]![0]).toBeGreaterThan(2); expect(result.points[1]![1]).toBe(2); expect(result.points[1]![2]).toBe(2)
  expect(() => routePhysicalConnection({ ...request, from: { point: [2, 2, 2], outward: [1, 0, 0], obstacleId: 'pump' }, obstacles: [own, { id: 'other', min: [2.1, 1, 1], max: [4, 3, 3] }] })).toThrow('nozzle exit is blocked')
})
test('routing constraints refuse stale terminals, duplicate ids and diagonal nozzle directions', () => {
  const data = { terminals: [{ id: 'a', elementId: 'pump', subjectId: 'pump', port: 'outlet', local: [2, 1, 1], outward: [1, 0, 0] }, { id: 'b', elementId: 'tank', subjectId: 'tank', port: 'inlet', local: [0, 1, 1], outward: [-1, 0, 0] }], connections: [{ id: 'pipe', graphConnectionId: 'supply', from: 'a', to: 'b', kind: 'pipe', diameter: .2, clearance: .1, bendRadius: .4, envelope: request.envelope, material: 'pipe', layerId: 'piping' }], obstacleElementIds: ['pump', 'tank'] }
  expect(physicalRoutingSchema.safeParse(data).success).toBe(true)
  expect(physicalRoutingSchema.safeParse({ ...data, connections: [{ ...data.connections[0], to: 'gone' }] }).success).toBe(false)
  expect(physicalRoutingSchema.safeParse({ ...data, terminals: [{ ...data.terminals[0], outward: [1, 1, 0] }, data.terminals[1]] }).success).toBe(false)
})
