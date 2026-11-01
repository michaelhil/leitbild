import { expect, test } from 'bun:test'
import { decide, parseCriticalBoron, priorSlope, toleranceK } from './reference-design-critical-boron'

const block = parseCriticalBoron('# x\n\n```ld01-critical-boron\n' + JSON.stringify({
  target: 'rodControlTavgMeasurandAtPreparedHotReference', measurand: 'rodControlTavgMeasurandAtSettledS3State',
  tolerance: { budgetFraction: 0.25, uncertaintyFractionOfSpan: 0.00806226, span_K: 400 },
  prior: 'packetFeedbackCoefficientsUniformShift', update: 'secantOfTheLastTwo', rounding_ppmEq: 0.001, maximumIterates: 5,
}) + '\n```\n')
const packet = {
  feedback_metadata: { parameters: { water_worth: 0.15, boron_per_ppm_eq: -8e-5, doppler_per_sqrt_k: -1.15e-3,
    domains: { boron_ppm_eq: { minimum: 0, maximum: 2500 } } } },
  feedback_reference: { fuelTemperature_K: [929.3, 929.3], waterDensity_kg_m3: [715.3052293172567, 679.3368894359069],
    moderatorTemperature_K: [578.15, 593.15], boron_ppmEq: [1538, 1538] },
}
const tref = 578.113
const m = (tavg: number) => ({ tref_full_power_k: tref, settled_tavg_k: tavg, error_k: tavg - tref })

test('tolerance is the operator-grade Tavg budget: a quarter of 0.806 % of the 0-400 C span', () => {
  expect(toleranceK(block)).toBeCloseTo(0.806226, 12)
})

test('the prior slope is the packet coefficients at zero reactivity change', () => {
  const p = priorSlope(packet), beta = (715.3052293172567 - 679.3368894359069) / ((715.3052293172567 + 679.3368894359069) / 2) / 15
  expect(p.expansion_per_K).toBeCloseTo(beta, 15)
  const rhoT = -0.15 * beta + 8e-5 * 1538 * beta - 1.15e-3 / (2 * Math.sqrt(929.3))
  expect(p.rhoT_per_K).toBeCloseTo(rhoT, 15)
  expect(p.dTavg_dc_K_per_ppmEq).toBeCloseTo(-(-8e-5) / rhoT, 12)
  expect(p.dTavg_dc_K_per_ppmEq).toBeLessThan(0)
})

test('iterate 0 is never accepted; iterate 1 steps on the prior; then the secant', () => {
  const s = priorSlope(packet).dTavg_dc_K_per_ppmEq
  const d0 = decide(block, 1538, packet, [{ boron_ppmEq: 1538, measurement: m(tref - 0.3) }]) as { next_ppmEq: number }
  expect(d0.next_ppmEq).toBeCloseTo(1538 - -0.3 / s, 3)
  expect(d0.next_ppmEq).toBeLessThan(1538)
  // A linear plant with a slope half the prior's: the secant lands on it.
  const plant = (c: number) => tref - 0.9 + (-0.4) * (c - 1538)
  const it = [{ boron_ppmEq: 1538, measurement: m(plant(1538)) }]
  const d1 = decide(block, 1538, packet, it) as { next_ppmEq: number }
  it.push({ boron_ppmEq: d1.next_ppmEq, measurement: m(plant(d1.next_ppmEq)) })
  const d2 = decide(block, 1538, packet, it) as { accepted?: { error_K: number }, next_ppmEq?: number }
  if (d2.accepted) expect(Math.abs(d2.accepted.error_K)).toBeLessThanOrEqual(toleranceK(block))
  else {
    expect(d2.next_ppmEq).toBeCloseTo(1538 - 0.9 / 0.4, 2)
    it.push({ boron_ppmEq: d2.next_ppmEq!, measurement: m(plant(d2.next_ppmEq!)) })
    const d3 = decide(block, 1538, packet, it) as { accepted: { iterate: number, error_K: number } }
    expect(d3.accepted.iterate).toBe(2)
    expect(Math.abs(d3.accepted.error_K)).toBeLessThan(1e-3)
  }
})

test('refusals: wrong start, inconsistent error, moved Tref, exhausted iterates', () => {
  expect(() => decide(block, 1538, packet, [])).toThrow()
  expect(() => decide(block, 1538, packet, [{ boron_ppmEq: 1500, measurement: m(tref) }])).toThrow()
  expect(() => decide(block, 1538, packet, [{ boron_ppmEq: 1538, measurement: { ...m(tref - 1), error_k: 0 } }])).toThrow()
  expect(() => decide(block, 1538, packet, [{ boron_ppmEq: 1538, measurement: m(tref - 1) },
    { boron_ppmEq: 1537, measurement: { tref_full_power_k: tref + 1, settled_tavg_k: tref, error_k: -1 } }])).toThrow()
  const far = Array.from({ length: 5 }, (_, k) => ({ boron_ppmEq: 1538 - k, measurement: m(tref - 5 + 0.01 * k) }))
  expect(() => decide(block, 1538, packet, far)).toThrow()
})
