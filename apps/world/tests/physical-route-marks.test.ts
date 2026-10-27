import { expect, test } from 'bun:test'
import { physicalRouteDisplayPaths, physicalRouteScreenMarks } from '../src/ui/physical-layout/route-marks.ts'
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
