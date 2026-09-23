import { describe, expect, test } from 'bun:test'
import { chuteFlow, collectionBasis as b, settlingDisposition, terminalSpeed } from './reference-design-containment-collection'

describe('Offline selected containment collection reductions', () => {
  test('open, drowned, reversed, blocked and dry chute share one signed law', () => {
    expect(chuteFlow(16, 14, b.returnCrest_m, 0.5)).toBe(0)
    expect(chuteFlow(16.4, 14, b.returnCrest_m, 0.5)).toBeGreaterThan(0)
    expect(chuteFlow(16.4, 16.4, b.returnCrest_m, 0.5)).toBe(0)
    expect(chuteFlow(16.3, 16.4, b.returnCrest_m, 0.5)).toBeLessThan(0)
    expect(chuteFlow(16.4, 14, b.returnCrest_m, 0)).toBe(0)
    expect(chuteFlow(16.4, 14, b.returnCrest_m, 0.25)).toBe(chuteFlow(16.4, 14, b.returnCrest_m, 0.5) / 2)
    expect(chuteFlow(16.4, 16.3, b.returnCrest_m, 0.5)).toBe(-chuteFlow(16.3, 16.4, b.returnCrest_m, 0.5))
    expect(() => chuteFlow(16.4, 14, 16, -1)).toThrow()
    expect(chuteFlow(15.6, 4, b.wstRim_m, b.wstSpillWidth_m)).toBeGreaterThan(0)
  })
  test('finite origin and physical engulfment, not a settling floor', () => {
    expect(settlingDisposition(0, 4)).toEqual({ mode: 'empty', flow_kg_s: 0 })
    expect(settlingDisposition(10, 4, 2)).toEqual({ mode: 'settling', flow_kg_s: 1.25 })
    expect(settlingDisposition(10, 20)).toEqual({ mode: 'engulfment', transferredMass_kg: 10 })
    expect(() => settlingDisposition(10, 4)).toThrow()
  })
  test('terminal drag covers finite Re and responds to maintained size', () => {
    const small = terminalSpeed(0.0005, 997, 1.184, 1.85e-5)
    const large = terminalSpeed(0.002, 997, 1.184, 1.85e-5)
    expect(small.reynolds).toBeGreaterThan(1)
    expect(large.reynolds).toBeGreaterThan(small.reynolds)
    expect(large.speed_m_s).toBeGreaterThan(small.speed_m_s)
    expect(Math.abs(large.forceResidual_N_m3)).toBeLessThan(1e-8)
    expect(() => terminalSpeed(0.001, 1, 1000, 1e-5)).toThrow()
  })
})
