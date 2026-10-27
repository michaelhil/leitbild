import { expect, test } from 'bun:test'
import { physicalRouteIntersects, routePhysicalConnection, roundedPhysicalRoute, validatePhysicalConnectionRoute, type PhysicalRouteRequest } from '../src/packs/physical-layout/native/routing/route.ts'
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
  expect(() => routePhysicalConnection({ ...request, obstacles: [{ id: 'sealed', min: [4, -1, -1], max: [6, 11, 11] }] })).toThrow('No admissible 3D route found')
})
test('terminal escape exempts only its own equipment and preserves the specified port direction', () => {
  const own = { id: 'pump', min: [0, 1, 1] as const, max: [2, 3, 3] as const }
  const result = routePhysicalConnection({ ...request, from: { point: [2, 2, 2], outward: [1, 0, 0], obstacleId: 'pump' }, obstacles: [own] })
  expect(result.points[1]![0]).toBeGreaterThan(2); expect(result.points[1]![1]).toBe(2); expect(result.points[1]![2]).toBe(2)
  expect(() => routePhysicalConnection({ ...request, from: { point: [2, 2, 2], outward: [1, 0, 0], obstacleId: 'pump' }, obstacles: [own, { id: 'other', min: [2.1, 1, 1], max: [4, 3, 3] }] })).toThrow('nozzle exit is blocked')
})
test('routing constraints refuse stale terminals, duplicate ids and diagonal nozzle directions', () => {
  const data = { geometryTolerance: .01, terminals: [{ id: 'a', elementId: 'pump', subjectId: 'pump', port: 'outlet', local: [2, 1, 1], outward: [1, 0, 0] }, { id: 'b', elementId: 'tank', subjectId: 'tank', port: 'inlet', local: [0, 1, 1], outward: [-1, 0, 0] }], connections: [{ id: 'pipe', graphConnectionId: 'supply', from: 'a', to: 'b', kind: 'pipe', diameter: .2, clearance: .1, bendRadius: .4, envelope: request.envelope, material: 'pipe', layerId: 'piping' }], obstacleElementIds: ['pump', 'tank'] }
  expect(physicalRoutingSchema.safeParse(data).success).toBe(true)
  expect(physicalRoutingSchema.safeParse({ ...data, connections: [{ ...data.connections[0], to: 'gone' }] }).success).toBe(false)
  expect(physicalRoutingSchema.safeParse({ ...data, terminals: [{ ...data.terminals[0], outward: [1, 1, 0] }, data.terminals[1]] }).success).toBe(false)
})

test('a nozzle facing away from its destination keeps its real exit direction and uses bend-feasible return geometry', () => {
  const result = routePhysicalConnection({ ...request, from: { point: [1, 2, 2], outward: [-1, 0, 0] }, obstacles: [] })
  expect(result.points[1]![0]).toBeLessThan(1)
  expect(result.bends).toBeGreaterThan(0)
  expect(() => roundedPhysicalRoute(result.points, request.bendRadius, .001)).not.toThrow()
})

test('ordered via points beyond the destination survive simplification and true-radius fillets', () => {
  const via = [[13, 4, 2], [15, 5, 2]] as const
  const result = routePhysicalConnection({ ...request, to: { ...request.to, point: [9, 8, 2] }, obstacles: [], envelope: { min: [0, 0, 0], max: [20, 10, 10] }, via })
  const rounded = roundedPhysicalRoute(result.points, request.bendRadius, .001)
  let previous = -1
  for (const point of via) {
    const index = rounded.findIndex(p => p.every((value, axis) => Math.abs(value - point[axis]!) < 1e-12))
    expect(index).toBeGreaterThan(previous); previous = index
    expect(result.points.some(p => p.every((value, axis) => value === point[axis]))).toBe(true)
  }
})

test('circular elbows have the actual authored radius and tolerance, with exact tangent endpoints', () => {
  const tolerance = .001, result = roundedPhysicalRoute([[0, 0, 0], [2, 0, 0], [2, 2, 0]], 1, tolerance), arc = result.slice(1, -1)
  expect(arc[0]).toEqual([1, 0, 0]); expect(arc.at(-1)).toEqual([2, 1, 0])
  for (const point of arc) expect(Math.hypot(point[0] - 1, point[1] - 1)).toBeCloseTo(1, 12)
  for (let index = 1; index < arc.length; index++) {
    const a = arc[index - 1]!, b = arc[index]!, chord = Math.hypot(b[0] - a[0], b[1] - a[1])
    expect(1 - Math.sqrt(1 - chord * chord / 4)).toBeLessThanOrEqual(tolerance)
  }
  expect(() => roundedPhysicalRoute([[0, 0, 0], [.2, 0, 0], [.2, .2, 0]], 1, tolerance)).toThrow('minimum bend radius')
  expect(() => roundedPhysicalRoute([[0, 0, 0], [1, 0, 0], [0, 0, 0]], .1, tolerance)).toThrow('180-degree')
  expect(() => roundedPhysicalRoute([[0, 0, 0], [2, 0, 0], [2, .6, 0], [4, .6, 0]], .4, tolerance)).toThrow('minimum bend radius')
})

test('rotated unit nozzle directions use a ray exit from their own equipment envelope', () => {
  const d = Math.SQRT1_2, from = { point: [2, 3, 2] as const, outward: [d, d, 0] as const, obstacleId: 'pump' }, to = { point: [9, 6, 2] as const, outward: [-d, -d, 0] as const, obstacleId: 'tank' }
  const obstacles = [{ id: 'pump', min: [0, 1, 1] as const, max: [2, 3, 3] as const }, { id: 'tank', min: [9, 6, 1] as const, max: [11, 8, 3] as const }]
  const result = routePhysicalConnection({ ...request, from, to, obstacles, envelope: { min: [-1, 0, 0], max: [15, 12, 10] } })
  const first = result.points[1]!
  expect(first[0] - from.point[0]).toBeCloseTo(first[1] - from.point[1], 12)
  expect(first[0]).toBeGreaterThan(from.point[0])
  const rounded = roundedPhysicalRoute(result.points, request.bendRadius, .001)
  for (const obstacle of obstacles) {
    const reserved = { min: obstacle.min.map(value => value - .2) as unknown as [number, number, number], max: obstacle.max.map(value => value + .2) as unknown as [number, number, number] }
    for (let index = 1; index < rounded.length; index++) if (!(obstacle.id === 'pump' && index === 1) && !(obstacle.id === 'tank' && index === rounded.length - 1)) expect(physicalRouteIntersects(rounded[index - 1]!, rounded[index]!, reserved)).toBe(false)
  }
})

test('waypoints on nozzle stubs and after bends remain actual sampled centreline points', () => {
  for (const via of [[[1.2, 2, 2], [8.8, 2, 2]], [[3, 3, 2], [6, 4, 2]]] as const) {
    const result = routePhysicalConnection({ ...request, obstacles: [], via })
    const rounded = roundedPhysicalRoute(result.points, request.bendRadius, .001)
    for (const point of via) expect(rounded.some(p => p.every((v, axis) => Math.abs(v - point[axis]!) < 1e-12))).toBe(true)
  }
})

test('routing is stable under large source-origin translations and refuses non-unit terminal vectors', () => {
  const shift = (p: readonly [number, number, number]) => p.map(v => v + 1_000_000) as [number, number, number]
  const shifted: PhysicalRouteRequest = { ...request,
    from: { ...request.from, point: shift(request.from.point) }, to: { ...request.to, point: shift(request.to.point) },
    envelope: { min: shift(request.envelope.min), max: shift(request.envelope.max) }, obstacles: request.obstacles.map(box => ({ ...box, min: shift(box.min), max: shift(box.max) })),
  }
  const result = routePhysicalConnection(shifted)
  expect(result.points[0]).toEqual(shifted.from.point); expect(result.points.at(-1)).toEqual(shifted.to.point)
  expect(() => roundedPhysicalRoute(result.points, request.bendRadius, .001)).not.toThrow()
  for (const outward of [[2, 0, 0], [0, 0, 0], [Number.NaN, 0, 1]] as const) expect(() => routePhysicalConnection({ ...request, from: { ...request.from, outward } })).toThrow('unit outward')
})

test('retained solutions validate current constraints without searching or repairing a stale path', () => {
  const route = routePhysicalConnection(request)
  expect(validatePhysicalConnectionRoute(request, route.points)).toEqual({ length: route.length, bends: route.bends })
  expect(() => validatePhysicalConnectionRoute({ ...request, from: { ...request.from, point: [1.1, 2, 2] } }, route.points)).toThrow('endpoints')
  expect(() => validatePhysicalConnectionRoute({ ...request, from: { ...request.from, outward: [-1, 0, 0] } }, route.points)).toThrow('outward direction')
  expect(() => validatePhysicalConnectionRoute({ ...request, via: [[2, 9, 2]] }, route.points)).toThrow('required straight-through waypoint')
  expect(() => validatePhysicalConnectionRoute({ ...request, obstacles: [...request.obstacles, { id: 'new-cabinet', min: [.9, 1.9, 1.9], max: [1.2, 2.1, 2.1] }] }, route.points)).toThrow('obstacle clearance')
  expect(() => validatePhysicalConnectionRoute({ ...request, bendRadius: 5 }, route.points)).toThrow('minimum bend radius')
  expect(() => validatePhysicalConnectionRoute({ ...request, radius: .5 }, route.points)).toThrow('exceed its tube radius')
})

test('accepted circular routes refuse nonlocal crossings and overlapping parallel runs', () => {
  const base: PhysicalRouteRequest = { ...request, from: { point: [0, 0, 0], outward: [1, 0, 0] }, to: { point: [2, -2, 0], outward: [0, 1, 0] }, obstacles: [], envelope: { min: [-2, -4, -2], max: [6, 6, 4] } }
  expect(() => validatePhysicalConnectionRoute(base, [[0, 0, 0], [4, 0, 0], [4, 4, 0], [2, 4, 0], [2, -2, 0]])).toThrow('own nonlocal tube reservation')
  const parallel: PhysicalRouteRequest = { ...base, to: { point: [3, .15, 0], outward: [-1, 0, 0] } }
  expect(() => validatePhysicalConnectionRoute(parallel, [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [0, .15, 0], [3, .15, 0]])).toThrow('own nonlocal tube reservation')
  expect(() => validatePhysicalConnectionRoute({ ...parallel, to: { ...parallel.to, point: [3, .5, 0] } }, [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [0, .5, 0], [3, .5, 0]])).not.toThrow()
  expect(() => validatePhysicalConnectionRoute({ ...base, to: { ...base.to, point: [2, -2, 2] } }, [[0, 0, 0], [4, 0, 0], [4, 4, 0], [2, 4, 0], [2, 4, 2], [2, -2, 2]])).not.toThrow()
})

test('a declared coincident start/end graph junction permits only its local closed-loop neighbourhood', () => {
  const base: PhysicalRouteRequest = { ...request, from: { point: [0, 0, 0], outward: [1, 0, 0] }, to: { point: [0, 0, 0], outward: [0, 1, 0] }, obstacles: [], envelope: { min: [-2, -4, -2], max: [6, 6, 4] } }
  expect(() => validatePhysicalConnectionRoute(base, [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [0, 0, 0]])).not.toThrow()
  expect(() => validatePhysicalConnectionRoute(base, [[0, 0, 0], [4, 0, 0], [4, 4, 0], [-1, 4, 0], [-1, -1, 0], [2, -1, 0], [2, 2, 0], [0, 2, 0], [0, 0, 0]])).toThrow('own nonlocal tube reservation')
})

test('serialized PWR touching fillets share one exact tangent joint without a reversed microsegment', () => {
  const failures = [
    { id: 'pressurizer-surge-line', radius: .8519999999999999, points: [[-50.00000000000001, 10.94, 9.18], [-50.00000000000001, 24.306, 9.18], [-48.04600000000001, 24.306, 9.18], [-48.04600000000001, 24.306, 7.02], [-49.75000000000001, 24.306, 7.02], [-49.75000000000001, 25.45, 7.02]] },
    { id: 'sg-b-steam-to-msiv-b', radius: 2.16, points: [[-38.00000000000001, 19.137999999999998, 12.84], [-38.00000000000001, 1.0200000000000005, 12.84], [-20.67, 1.0200000000000005, 12.84], [-20.67, 1.0200000000000005, 20.16], [-20.67, -3.3, 20.16], [-20.67, -3.3, 15.84], [-18, -3.3, 15.84]] },
  ]
  for (const failure of failures) {
    const points = roundedPhysicalRoute(failure.points as [number, number, number][], failure.radius, .005)
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i]!.map((v, axis) => v - points[i - 1]![axis]!), b = points[i + 1]!.map((v, axis) => v - points[i]![axis]!)
      expect(Math.hypot(...a)).toBeGreaterThan(0)
      expect(a.reduce((sum, v, axis) => sum + v * b[axis]!, 0)).toBeGreaterThan(0)
    }
  }
  // A real one-micrometre straight is retained; this is not a metric weld.
  const separated = roundedPhysicalRoute([[0, 0, 0], [2, 0, 0], [2, 2.000001, 0], [4, 2.000001, 0]], 1, .005)
  expect(separated.some(point => point[0] === 2 && point[1] === 1)).toBe(true)
  expect(separated.some(point => point[0] === 2 && Math.abs(point[1] - 1.000001) < 1e-12)).toBe(true)
})
