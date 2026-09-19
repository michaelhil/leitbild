import { describe, expect, test } from 'bun:test'
import { cetBasisSchema, parseCetBasis, cetGeometry, cetHeat, cetBathResponse, cetEquilibrium, cetComparison } from './reference-design-cet'

const basis = cetBasisSchema.parse({ diameter_m: .003, length_m: .03, density_kg_m3: 8000,
  heatCapacity_J_kgK: 500, conductivity_W_mK: 15, leadDiameter_m: .0002, leadLength_m: .1,
  liquidFilm_W_m2K: 1000, gasFilm_W_m2K: 30, effectiveRadiationFactor: .03,
  minimumBody_C: 20, maximumBody_C: 800 })
const clad = [{ areaWeight: .25, temperature_C: 700 }, { areaWeight: .75, temperature_C: 500 }]

describe('offline CET physical selection', () => {
  test('requires one strict owner basis', () => {
    const doc = '```reference-cet-basis\n' + JSON.stringify(basis) + '\n```'
    expect(parseCetBasis(doc)).toEqual(basis)
    expect(() => parseCetBasis(doc + doc)).toThrow()
    expect(() => cetBasisSchema.parse({ ...basis, unrelated: 1 })).toThrow()
    expect(() => cetBasisSchema.parse({ ...basis, diameter_m: 0 })).toThrow()
  })
  test('checks lumped-body and omitted lead scales without hiding gas lag', () => {
    const g = cetGeometry(basis)
    expect(g.capacity_J_K).toBeCloseTo(.873362757698, 10)
    expect(g.liquidBiot * 2).toBeLessThan(.1)
    expect(g.dryLeadBiasBound_K).toBeLessThan(1)
    expect(g.gasTimeConstant_s / g.liquidTimeConstant_s).toBeCloseTo(1000 / 30, 10)
    expect(g.lumpedLeadCapacityFraction).toBeLessThan(.03)
  })
  test('all heat debits finite physical owners, including radiation sign and partition', () => {
    for (const liquidExposure of [0, .25, 1]) for (const body_C of [100, 400, 790]) {
      const q = cetHeat(basis, body_C, { liquidExposure, liquid_C: 100, gas_C: 300, clad })
      expect(q.probe_W + q.liquid_W + q.gas_W + q.clad_W.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 12)
      expect(Math.sign(q.clad_W[0]!)).toBeCloseTo(liquidExposure === 1 ? 0 : Math.sign(body_C - 700), 12)
    }
    const hot = cetHeat(basis, 790, { liquidExposure: 0, gas_C: 300, clad })
    expect(hot.clad_W.every(v => v > 0)).toBe(true)
  })
  test('absent phases have no invented temperatures or heat paths', () => {
    expect(cetHeat(basis, 300, { liquidExposure: 0, gas_C: 300, clad }).liquid_W).toBeCloseTo(0, 12)
    const wet = cetHeat(basis, 300, { liquidExposure: 1, liquid_C: 100, clad })
    expect(wet.gas_W).toBeCloseTo(0, 12)
    expect(wet.clad_W.every(v => v === 0)).toBe(true)
    expect(() => cetHeat(basis, 300, { liquidExposure: .5, gas_C: 300, clad })).toThrow()
    expect(() => cetHeat(basis, 300, { liquidExposure: 0, gas_C: 300, clad: [{ areaWeight: .5, temperature_C: 500 }] })).toThrow()
    expect(() => cetHeat(basis, 801, { liquidExposure: 0, gas_C: 300, clad })).toThrow()
  })
  test('finite body retains a delayed response; prescribed-bath exact result composes', () => {
    const first = cetBathResponse(basis, 100, 300, 10, false)
    expect(first).toBeLessThan(125)
    expect(cetBathResponse(basis, 100, 300, 10, true)).toBeGreaterThan(290)
    expect(cetBathResponse(basis, first, 300, 50, false)).toBeCloseTo(cetBathResponse(basis, 100, 300, 60, false), 12)
    expect(cetBathResponse(basis, 300, 100, 0, true)).toBe(300)
  })
  test('radiative bias is a physical reading, not an electronic fault or hottest fuel', () => {
    const env = { liquidExposure: 0, gas_C: 300, clad: [{ areaWeight: 1, temperature_C: 700 }] }
    const t = cetEquilibrium(basis, env)
    expect(t).toBeGreaterThan(300)
    expect(t).toBeLessThan(700)
    expect(cetHeat(basis, t, env).probe_W).toBeCloseTo(0, 12)
    expect(cetEquilibrium({ ...basis, effectiveRadiationFactor: 0 }, env)).toBeCloseTo(300, 10)
    expect(cetComparison(basis).connectedCoreQualified).toBe(false)
  })
})
