import { expect, test } from 'bun:test'
import type { PhysicalSceneBounds } from '../src/core/packs/scene.ts'
import { createPhysicalSpatialIndex, visitPhysicalSpatialBounds, visitPhysicalAtomicOverlapPairs } from '../src/ui/map/physical-scene/spatial-index.ts'

const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number): PhysicalSceneBounds => ({ min: [x, y, z], max: [x + dx, y + dy, z + dz] })
const compare = (values: readonly PhysicalSceneBounds[]): void => {
  const index = createPhysicalSpatialIndex(values, 'overlap'), expected: string[] = [], actual: string[] = []
  values.forEach((bounds, later) => visitPhysicalSpatialBounds(index, bounds, earlier => { if (earlier < later) expected.push(`${earlier}/${later}`) }))
  visitPhysicalAtomicOverlapPairs(index, (earlier, later) => { expect(earlier).toBeLessThan(later); actual.push(`${earlier}/${later}`) })
  expect(new Set(actual).size).toBe(actual.length)
  expect(actual.sort()).toEqual(expected.sort())
}

test('atomic self-pair traversal reproduces every earlier/later leaf query exactly once', () => {
  compare([]); compare([box(0, 0, 0, 0, 0, 0)])
  compare(Array.from({ length: 17 }, () => box(-0, 0, -0, 4, 4, 0)))
  let seed = 1827
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32 }
  for (let trial = 0; trial < 12; trial++) compare(Array.from({ length: 96 }, (_, id) => box(id === 0 ? 1e5 : random() * 100, random() * 1e3, random(), random() * 100, random() * 20, id % 3 ? random() : 0)))
})

test('self-pair traversal refuses a non-atomic ray leaf rather than omitting its pairs', () => {
  const values = [box(0, 0, 0, 1, 1, 0), box(0, 0, 0, 1, 1, 0)]
  expect(() => visitPhysicalAtomicOverlapPairs(createPhysicalSpatialIndex(values, 'ray'), () => {})).toThrow('Self-pair traversal requires an atomic overlap hierarchy')
})

test('atomic pair pruning retains both floating orientations at touching and translated bounds', () => {
  for (const scale of [Number.MIN_VALUE, 2 ** -40, 1, 2 ** 40, 1e100, Number.MAX_VALUE / 16]) {
    const step = Math.max(Number.MIN_VALUE, scale * Number.EPSILON)
    compare([...Array.from({ length: 25 }, (_, id) => box(scale + (id - 8) * step, scale, 0, Math.max(step, scale / 4), step, step)), box(-0, 0, -0, 0, 0, 0), box(-scale, -scale, -scale, scale, scale, scale)])
    compare(Array.from({ length: 25 }, (_, id) => box(scale + id * step, scale + id * step, scale + id * step, 0, 0, 0)))
  }
})
