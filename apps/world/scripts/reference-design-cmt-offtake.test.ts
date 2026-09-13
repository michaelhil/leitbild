import { expect, test } from 'bun:test'
import { captureAtFlow, downwardQuality, onsetHeight, parseOfftakeBasis } from './reference-design-cmt-offtake.ts'

test('downward source equation has exact endpoints and monotone composition', () => {
  expect(downwardQuality(0, 800, 25)).toBe(1)
  expect(downwardQuality(1, 800, 25)).toBe(0)
  let prior = 1
  for (let n = 1; n <= 100; n++) {
    const x = downwardQuality(n / 100, 800, 25)
    expect(x).toBeLessThan(prior); prior = x
  }
})
test('continuous liquid flow determines onset in the same composition trial', () => {
  const h0 = onsetHeight(25, 800, 25), h = .5 * h0
  const result = captureAtFlow(25, h, 800, 25)
  expect(result.captureQuality).toBeGreaterThan(0)
  expect(result.captureQuality).toBeLessThan(downwardQuality(.5, 800, 25))
  expect(result.liquid_kg_s + result.vapor_kg_s).toBe(25)
  expect(Math.abs(result.residual)).toBeLessThan(1e-12)
  expect(result.onset_m).toBe(onsetHeight(result.liquid_kg_s, 800, 25))
  expect(captureAtFlow(25, h0, 800, 25).captureQuality).toBe(0)
  expect(captureAtFlow(0, 0, 800, 25).captureQuality).toBeNull()
  expect(captureAtFlow(25, 0, 800, 25).vapor_kg_s).toBe(25)
})
test('refuses reverse flow, absent phases, negative height and fabricated density contrast', () => {
  expect(() => captureAtFlow(-1, .1, 800, 25)).toThrow()
  expect(() => captureAtFlow(1, -.1, 800, 25)).toThrow()
  expect(() => captureAtFlow(1, .1, 800, 0)).toThrow()
  expect(() => captureAtFlow(1, .1, 800, 800)).toThrow()
  expect(() => captureAtFlow(1, .1, 800, 25, 0)).toThrow()
  expect(() => parseOfftakeBasis('')).toThrow()
})
