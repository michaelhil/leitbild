import { expect, test } from 'bun:test'
import { intersectsPhysicalFrustum, overlapsPhysicalFootprint, physicalHeightFootprint } from '../src/ui/map/physical-scene/visibility.ts'
import type { PhysicalSceneBounds } from '../src/core/packs/scene.ts'
const bounds = (min: [number, number, number], max: [number, number, number]): PhysicalSceneBounds => ({ min, max })
const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

test('frustum exclusion is conservative with the camera or viewport inside large source bounds', () => {
  expect(intersectsPhysicalFrustum(identity, bounds([-2, -2, -2], [2, 2, 2]))).toBe(true)
  expect(intersectsPhysicalFrustum(identity, bounds([-.1, -.1, -.1], [.1, .1, .1]))).toBe(true)
  expect(intersectsPhysicalFrustum(identity, bounds([2, -.1, -.1], [3, .1, .1]))).toBe(false)
  expect(intersectsPhysicalFrustum(identity, bounds([-1, -1, -1], [-1, 1, 1]))).toBe(true)
})

test('height-aware exclusion retains a visible tower top whose ground base is offscreen', () => {
  const matrix = identity.slice(); matrix[8] = -2
  const tower = bounds([2.1, -.1, 0], [2.3, .1, 1])
  expect(intersectsPhysicalFrustum(matrix, tower)).toBe(true)
  expect(intersectsPhysicalFrustum(matrix, { ...tower, max: [2.3, .1, .1] })).toBe(false)
  const ground = bounds([-1, -1, 0], [1, 1, 0]), eye = [4, 0, 2] as const
  expect(overlapsPhysicalFootprint(tower, physicalHeightFootprint(ground, eye, 0, 1))).toBe(true)
  expect(overlapsPhysicalFootprint(tower, physicalHeightFootprint(ground, eye, 0, .1))).toBe(false)
  expect(overlapsPhysicalFootprint(bounds([-100, -100, 0], [100, 100, 1]), physicalHeightFootprint(ground, eye, 0, 1))).toBe(true)
})

test('horizon, eye-height crossing and invalid camera bounds cannot falsely prove exclusion', () => {
  const ground = bounds([-1, -1, 0], [1, 1, 0]), far = bounds([1000, 1000, 0], [1001, 1001, 10])
  for (const eye of [[0, 0, 0], [0, 0, 5], [0, 0, NaN]] as const) expect(overlapsPhysicalFootprint(far, physicalHeightFootprint(ground, eye, 0, 10))).toBe(true)
  const invalid = identity.slice(); invalid[0] = NaN; expect(intersectsPhysicalFrustum(invalid, far)).toBe(true)
})
