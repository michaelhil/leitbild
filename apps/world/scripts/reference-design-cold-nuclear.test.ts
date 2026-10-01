import { expect, test } from 'bun:test'
import { parseColdNuclear } from './reference-design-cold-nuclear'

const input: ReturnType<typeof parseColdNuclear> = { fuelRange_K: [290, 2000], dopplerWorth_pcm_sqrtK: -115,
  dopplerSensitivity_pcm_sqrtK: [-90, -115, -140], waterWorth: .15,
  waterWorthChallenges: [.12, .15, .20], absorberWorth_pcm_ppmEq: -8,
  absorberReference_ppmEq: 1000, bankWorth: .10, bankReference: .70, xenonWorth: -.002,
  source: { identity: 'LD01.CORE.SOURCE.CF252', location: 'complete-core dedicated nonfuel source guide',
    birthEmission_neutrons_s: 4e9, halfLife_year: 2.645,
    couplingIntensity_per_neutron: 2e-16, ageAtPreparation_year: 0, couplingChallenges: [.25, 1, 4] },
  coldPreparation: { pressure_Pa: 300000, temperature_K: 300, absorberConcentration_ppmEq: 1000 },
  experiment: { sourceHold_s: 600, withdrawalTarget: .245, withdrawalHold_s: 600,
    releaseWindow_s: 20, poisonHorizon_h: 72 } }
const doc = (value: unknown) => '```reference-cold-nuclear\n' + JSON.stringify(value) + '\n```\n'
test('cold source owns finite physical emission and coupling rather than a power floor', () => {
  expect(parseColdNuclear(doc(input))).toEqual(input)
})
test('cold law rejects missing, duplicate, silent domain and source substitutions', () => {
  for (const bad of ['', doc(input) + doc(input), doc({ ...input, extra: 1 }),
    doc({ ...input, fuelRange_K: [250, 2000] }), doc({ ...input, dopplerWorth_pcm_sqrtK: 0 }),
    doc({ ...input, source: { ...input.source, birthEmission_neutrons_s: 0 } }),
    doc({ ...input, source: { ...input.source, ageAtPreparation_year: -1 } }),
    doc({ ...input, source: { ...input.source, floor: 1e-10 } })]) expect(() => parseColdNuclear(bad)).toThrow()
})
test('nominal law is among explicit challenges and actual travel remains finite', () => {
  for (const bad of [doc({ ...input, waterWorth: .19 }), doc({ ...input, dopplerWorth_pcm_sqrtK: -110 }),
    doc({ ...input, experiment: { ...input.experiment, withdrawalTarget: 1.1 } }),
    doc({ ...input, experiment: { ...input.experiment, poisonHorizon_h: 0 } })]) expect(() => parseColdNuclear(bad)).toThrow()
})
