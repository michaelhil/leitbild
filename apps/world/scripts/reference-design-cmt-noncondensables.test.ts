import { expect, test } from 'bun:test'
import { cmtProbeBasis, cmtProbeHeat } from './reference-design-cmt-noncondensables'
import { cetGeometry } from './reference-design-cet'

test('CMT probe retains finite heat and skips an absent phase', () => {
  const dry = cmtProbeHeat(100, 0, undefined, 300)
  const wet = cmtProbeHeat(100, 1, 300)
  expect(dry.liquid_W).toBeCloseTo(0, 12)
  expect(wet.gas_W).toBeCloseTo(0, 12)
  for (const q of [dry, wet, cmtProbeHeat(150, .1, 100, 300)]) {
    expect(q.body_W + q.liquid_W + q.gas_W).toBeCloseTo(0, 12)
  }
  expect(() => cmtProbeHeat(100, .1, undefined, 300)).toThrow()
  expect(() => cmtProbeHeat(100, 0)).toThrow()
})

test('selected dry response is slower, with no stacked acquisition lag', () => {
  const g = cetGeometry(cmtProbeBasis)
  expect(g.capacity_J_K).toBeGreaterThan(0)
  expect(g.gasTimeConstant_s / g.liquidTimeConstant_s).toBeCloseTo(1000 / 30, 12)
  expect(g.liquidTimeConstant_s).toBeCloseTo(2.94179894, 6)
  expect(cmtProbeBasis.effectiveRadiationFactor).toBe(0)
})
