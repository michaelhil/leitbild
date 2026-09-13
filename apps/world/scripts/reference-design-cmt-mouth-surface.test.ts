import { expect, test } from 'bun:test'
import { mouthIntersection, partitionAperture, surfaceRate } from './reference-design-cmt-mouth-surface.ts'

test('first gas contact has continuous area without a whole-mouth flip or radius floor', () => {
  expect(mouthIntersection(.1, .001, 2).gasFraction).toBe(0)
  expect(mouthIntersection(.1, 0, 2).gasFraction).toBe(0)
  expect(mouthIntersection(.1, -2e-10, 2).gasFraction).toBeCloseTo(1e-8, 16)
  expect(mouthIntersection(.1, -.005, 2).gasFraction).toBeCloseTo(.25, 14)
  expect(mouthIntersection(.1, -.02, 2).gasFraction).toBeCloseTo(1, 14)
  expect(() => mouthIntersection(.1, 0, 0)).toThrow()
})
test('same aperture physical and effective areas partition once and close together', () => {
  const A = Math.PI * .1 ** 2, a = .004224072
  for (const opening of [0, .3, 1]) for (const f of [0, 1e-8, .25, .75, 1]) {
    const l = partitionAperture(A, a, 1 - f, opening), v = partitionAperture(A, a, f, opening)
    expect(l.physicalArea_m2 + v.physicalArea_m2).toBeCloseTo(A, 14)
    expect(l.effectiveArea_m2 + v.effectiveArea_m2).toBeCloseTo(a * opening, 14)
  }
  expect(() => partitionAperture(A, a, 2, 1)).toThrow()
})
test('graph kinematics use actual nonhorizontal normal and phase-transfer sign', () => {
  expect(surfaceRate(2, .3, .7, 0, 800)).toBeCloseTo(.1, 14)
  expect(surfaceRate(2, .3, .7, .02, 800)).toBeCloseTo(.1 - .02 * Math.sqrt(5) / 800, 14)
  expect(surfaceRate(0, .3, .7, -.02, 800)).toBeCloseTo(.7 + .02 / 800, 14)
  expect(() => surfaceRate(0, 0, 0, 1, 0)).toThrow()
})
