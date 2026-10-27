import type { PhysicalProjectedPoint } from '../src/ui/map/physical-scene/types.ts'
import { expect, test } from 'bun:test'
import { physicalRouteDisplayPaths, physicalRouteInspectionPaths, physicalRouteScreenMarks } from '../src/ui/physical-layout/route-marks.ts'
import { physicalArchitectureOpacity } from '../src/ui/map/physical-scene/architecture-opacity.ts'
import { changePhysicalLayoutView, initialPhysicalLayoutView } from '../src/ui/physical-layout/view.ts'

test('route annotations preserve disjoint scope gaps, merge overlapping members and retain exact floor crossings', () => {
  const a = { min: [0, 0, 0] as const, max: [4, 4, 4] as const }, b = { min: [6, 0, 0] as const, max: [10, 4, 4] as const }
  expect(physicalRouteDisplayPaths([[-2, 2, 2], [12, 2, 2]], [a, b])).toEqual([[[0, 2, 2], [4, 2, 2]], [[6, 2, 2], [10, 2, 2]]])
  expect(physicalRouteDisplayPaths([[-2, 2, 2], [12, 2, 2]], [a, { min: [3, 0, 0], max: [10, 4, 4] }])).toEqual([[[0, 2, 2], [10, 2, 2]]])
  expect(physicalRouteDisplayPaths([[1, 1, -2], [1, 1, 12]], [], { low: 0, high: 4 })).toEqual([[[1, 1, 0], [1, 1, 4]]])
})

test('route marks clip off-screen travel and retain ordered direction around bends without a marker count ceiling', () => {
  const point = (x: number, y: number) => ({ x, y, depth: 0, visible: true })
  const marks = physicalRouteScreenMarks([point(-1e6, 50), point(200, 50), point(200, 300)], { width: 300, height: 300 }, 10)
  expect(marks.length).toBeGreaterThan(3)
  expect(marks.every(mark => mark.point.x >= 0 && mark.point.x <= 300 && mark.point.y >= 0 && mark.point.y <= 300)).toBe(true)
  expect(marks.some(mark => mark.angle === 0)).toBe(true); expect(marks.some(mark => mark.angle === Math.PI / 2)).toBe(true)
  expect(physicalRouteScreenMarks([point(0, 10), point(20_000, 10)], { width: 20_000, height: 100 }, 10)).toHaveLength(250)
  expect(() => physicalRouteScreenMarks([], { width: 300, height: 300 }, 0)).toThrow('font size')
})

test('architecture opacity follows source kind and never an equipment name or material', () => {
  const view = { wallOpacity: .3, floorOpacity: .6 }
  expect(physicalArchitectureOpacity({ kind: 'wall' }, view)).toBe(.3)
  expect(physicalArchitectureOpacity({ kind: 'slab' }, view)).toBe(.6)
  for (const kind of ['equipment', 'pipe', 'pavement', 'support']) expect(physicalArchitectureOpacity({ kind }, view)).toBe(1)
  expect(physicalArchitectureOpacity({ kind: 'wall' }, {})).toBe(1)
})

test('opacity changes retain floor, mode and layers; malformed opacity is rejected', () => {
  const levels = [{ id: 'ground', label: 'Ground', elevation: 0 }], current = { ...initialPhysicalLayoutView(levels), mode: '3d' as const, hiddenLayerIds: ['roof'] }
  expect(changePhysicalLayoutView(current, { wallOpacity: 0, floorOpacity: .5 }, levels)).toEqual({ ...current, wallOpacity: 0, floorOpacity: .5 })
  for (const opacity of [-1, 2, NaN, Infinity]) expect(() => changePhysicalLayoutView(current, { wallOpacity: opacity }, levels)).toThrow('opacity')
})


test('unscoped all-floor paths borrow exact immutable source vertices without changing mark positions', () => {
  const points = [[0, 0, 0], [0, 0, 0], [100, 0, 0], [100, 100, 0]] as const
  const paths = physicalRouteDisplayPaths(points, [])
  expect(paths).toEqual([points]); expect(paths[0]).toBe(points); expect(physicalRouteDisplayPaths(points, [])).toBe(paths)
  expect(physicalRouteDisplayPaths([], [])).toEqual([]); expect(physicalRouteDisplayPaths([[1, 2, 3]], [])).toEqual([])
  const project = (path: typeof points | readonly (readonly [number, number, number])[]) => path.map(([x, y]) => ({ x, y, depth: 0, visible: true }))
  expect(physicalRouteScreenMarks(project(paths[0]!), { width: 200, height: 200 }, 10)).toEqual([{ point: { x: 40, y: 0 }, angle: 0 }, { point: { x: 100, y: 20 }, angle: Math.PI / 2 }, { point: { x: 100, y: 100 }, angle: Math.PI / 2 }])
})

test('one current path selection changes exactly with geometric scope/floor and releases visited selections', () => {
  const points = [[-2, 2, -2], [12, 2, 12]] as const, a = [{ min: [0, 0, 0] as const, max: [4, 4, 4] as const }], b = [{ min: [6, 0, 6] as const, max: [10, 4, 10] as const }]
  const first = physicalRouteDisplayPaths(points, a, { low: 0, high: 4 })
  expect(first).toEqual([[[0, 2, 0], [4, 2, 4]]]); expect(physicalRouteDisplayPaths(points, [{ ...a[0]! }], { low: 0, high: 4 })).toBe(first)
  expect(physicalRouteDisplayPaths(points, b, { low: 6, high: 10 })).toEqual([[[6, 2, 6], [10, 2, 10]]])
  const returned = physicalRouteDisplayPaths(points, a, { low: 0, high: 4 }); expect(returned).toEqual(first); expect(returned).not.toBe(first)
  const replacement = points.map(point => [...point] as [number, number, number]); expect(physicalRouteDisplayPaths(replacement, a, { low: 0, high: 4 })).not.toBe(returned)
})

test('one concurrently displayed multi-floor selection survives camera/opacity/separation magnitude and changes with actual source or scope', () => {
  const occurrence = { levelId: 'lower', clipToScope: true as const, spatialPath: { points: [[2, 2, -1], [2, 2, 9]] as const, radius: .1 }, inspectionLevels: [{ levelId: 'lower', low: 0, high: 4 }, { levelId: 'upper', low: 4, high: 8 }] }, regions = [{ min: [0, 0, -2] as const, max: [4, 4, 10] as const }]
  const first = physicalRouteInspectionPaths(occurrence, regions, { levelId: 'all', separation: 4 })
  expect(first).toEqual([{ levelId: 'lower', points: [[2, 2, 0], [2, 2, 4]] }, { levelId: 'upper', points: [[2, 2, 4], [2, 2, 8]] }])
  expect(physicalRouteInspectionPaths(occurrence, [{ ...regions[0]! }], { levelId: 'all', separation: 17 })).toBe(first)
  const lower = physicalRouteInspectionPaths(occurrence, regions, { levelId: 'lower', separation: 17 }); expect(lower).toEqual([first[0]!]); expect(lower).not.toBe(first)
  const stacked = physicalRouteInspectionPaths(occurrence, regions, { levelId: 'all', separation: 17 }); expect(stacked).toEqual(first); expect(stacked).not.toBe(first)
  expect(physicalRouteInspectionPaths(occurrence, [], { levelId: 'all', separation: 0 })[0]!.points).toBe(occurrence.spatialPath.points)
  const changed = { ...occurrence, spatialPath: { ...occurrence.spatialPath, points: [[3, 3, -1], [3, 3, 9]] as const } }
  expect(physicalRouteInspectionPaths(changed, regions, { levelId: 'lower', separation: 0 })).toEqual([{ levelId: 'lower', points: [[3, 3, 0], [3, 3, 4]] }])
  expect(physicalRouteInspectionPaths(occurrence, [{ min: [0, 0, 1] as const, max: [4, 4, 3] as const }], { levelId: 'lower', separation: 0 })).toEqual([{ levelId: 'lower', points: [[2, 2, 1], [2, 2, 3]] }])
})


// Frozen 4b5952aae sampling oracle. This is a numerical-equivalence guard for
// scalar allocation cleanup; changes to sampling policy must be reviewed apart.
const priorScreenMarks = (points: ReadonlyArray<PhysicalProjectedPoint>, viewport: { readonly width: number; readonly height: number }, fontSize: number) => {
  const output: Array<{ point: { x: number; y: number }; angle: number }> = [], spacing = fontSize * 8
  let distance = 0, next = spacing / 2
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!
    if (![a.x, a.y, b.x, b.y, a.depth, b.depth].every(Number.isFinite) || a.depth < -1 && b.depth < -1 || a.depth > 1 && b.depth > 1) continue
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy)
    if (length === 0) continue
    let low = 0, high = 1
    for (const [start, delta, limit] of [[a.x, dx, viewport.width], [a.y, dy, viewport.height]]) {
      if (delta === 0) { if (start! < 0 || start! > limit!) { high = -1; break } }
      else { const first = -start! / delta!, last = (limit! - start!) / delta!; low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last)) }
    }
    if (high > low) {
      let at = Math.max(next, Math.ceil((distance + low * length - spacing / 2) / spacing) * spacing + spacing / 2)
      while (at <= distance + high * length) { const part = (at - distance) / length; output.push({ point: { x: a.x + dx * part, y: a.y + dy * part }, angle: Math.atan2(dy, dx) }); at += spacing }
      next = at
    }
    distance += length
  }
  return output
}

test('scalar screen clipping matches the frozen sampler exactly through bends, invalids, depth cuts and boundary endpoints', () => {
  let state = 0x10727
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000 }
  const point = (x: number, y: number, depth = 0): PhysicalProjectedPoint => ({ x, y, depth, visible: true })
  const fixtures: PhysicalProjectedPoint[][] = [[], [point(1, 1)], [point(0, 0), point(0, 0), point(100, 0), point(100, 100)], [point(-0, -0), point(-100, -0), point(-100, 100)], [point(NaN, 0), point(0, 0), point(Infinity, 10), point(200, 20)], [point(0, 0, -2), point(100, 100, -1), point(200, 0, 1), point(0, 100, 2), point(200, 100, NaN)]]
  for (let index = 0; index < 100; index++) fixtures.push(Array.from({ length: 30 }, () => point((random() - .5) * 2000, (random() - .5) * 2000, (random() - .5) * 4)))
  for (const points of fixtures) for (const viewport of [{ width: 0, height: 0 }, { width: 400, height: 200 }, { width: 1937, height: 1027 }]) for (const fontSize of [7, 11.5, 23]) {
    expect(physicalRouteScreenMarks(points, viewport, fontSize)).toEqual(priorScreenMarks(points, viewport, fontSize))
  }
})
