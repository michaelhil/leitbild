import { describe, expect, test } from 'bun:test'
import { parseCmtLevelLeg, levelLegGeometry } from './reference-design-cmt-level-leg.ts'

const basis = { upperTap_m: 11.95, lowerTap_m: 6.001326357, bore_m: .006, outside_m: .01,
  topLength_m: .5, topFall_m: .05, bottomLength_m: .25, highLength_m: .5,
  chamberVolume_m3: .000002, chamberSteel_kg: .02, steelDensity_kg_m3: 8000,
  steelHeatCapacity_J_kgK: 500, steelConductivity_W_mK: 15, outsideCoefficient_W_m2K: 8,
  initialTemperature_K: 313.15, initialBoronMassFraction: .002, comparisonPressure_Pa: 15.2e6, hotComparison_K: 423.15, isolatedRise_K: 1 }
const markdown = (b: unknown) => '```reference-cmt-level-leg\n' + JSON.stringify(b) + '\n```'
describe('CMT level-leg physical ownership', () => {
  test('both legs and sensing chambers own additional water and steel', () => {
    const g = levelLegGeometry(parseCmtLevelLeg(markdown(basis)))
    expect(g.lowLength_m).toBeCloseTo(6.648673643, 10)
    expect(g.totalLength_m).toBeCloseTo(7.148673643, 10)
    expect(g.totalWaterVolume_m3).toBeCloseTo(g.lowVolume_m3 + g.highVolume_m3, 15)
    expect(g.steel_kg).toBeGreaterThan(2)
    expect(g.radialSteelResistance_K_W).toBeGreaterThan(0)
  })
  test('rejects hidden geometry or altered schema', () => {
    for (const b of [{ ...basis, outside_m: .005 }, { ...basis, topFall_m: .6 }, { ...basis, lowerTap_m: 12 },
      { ...basis, chamberVolume_m3: 0 }, { ...basis, hiddenConstantLevel: true }]) expect(() => parseCmtLevelLeg(markdown(b))).toThrow()
    expect(() => parseCmtLevelLeg(markdown(basis) + '\n' + markdown(basis))).toThrow()
  })
})
