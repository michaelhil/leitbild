import { expect, test } from 'bun:test'
import { parseSourceFeedback } from './reference-design-source-feedback'

const source = { generationTime_s: .00002,
  delayedFractions: [.00021, .00142, .00127, .00257, .00075, .00027],
  halfLives_s: [55.7, 22.7, 6.2, 2.3, .61, .23], fuelCoefficient_pcm_K: -2,
  moderatorCoefficient_pcm_K: -20, reactivityPulse_pcm: .5, steps_s: [.1, .05, .025, .0125] }
const decay = { fractions: [.01, .015, .015, .01, .01, .005], timeConstants_s: [1, 10, 100, 1000, 10000, 100000] }
const block = (name: string, value: unknown) => `\`\`\`${name}\n${JSON.stringify(value)}\n\`\`\`\n`
const sdoc = (s: unknown) => block('reference-source-feedback', s)
const hdoc = (h: unknown) => block('reference-decay-energy', h)

test('neutron groups and delayed-energy groups have distinct owning records', () => {
  const parsed = parseSourceFeedback(sdoc(source), hdoc(decay))
  expect(parsed).toEqual({ source, decay })
  expect(parsed.source.delayedFractions.reduce((a, b) => a + b, 0)).toBeCloseTo(.00649, 12)
  expect(parsed.decay.fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(.065, 12)
})

test('ambiguous or unavailable source basis is rejected instead of defaulted', () => {
  for (const s of ['', sdoc(source) + sdoc(source), hdoc(decay)])
    expect(() => parseSourceFeedback(s, hdoc(decay))).toThrow()
  for (const h of ['', hdoc(decay) + hdoc(decay), sdoc(source)])
    expect(() => parseSourceFeedback(sdoc(source), h)).toThrow()
})

test('invalid source normalization and hidden thermal parameters are rejected', () => {
  for (const invalid of [{ ...source, generationTime_s: 0 }, { ...source, delayedFractions: [1] },
    { ...source, delayedFractions: [1, 1, 1, 1, 1, 1] }, { ...source, halfLives_s: [1, 1, 1, 1, 1, 0] },
    { ...source, fuelCoefficient_pcm_K: 0 }, { ...source, referenceFuelTemperature: 600 },
    { ...source, steps_s: [.1, .1] }, { ...source, steps_s: [.1, 0] }])
    expect(() => parseSourceFeedback(sdoc(invalid), hdoc(decay))).toThrow()
  for (const invalid of [{ ...decay, fractions: [.2, .2, .2, .2, .2, .2] },
    { ...decay, timeConstants_s: [0, 10, 100, 1000, 10000, 100000] }, { ...decay, heatCapacity: 45 }])
    expect(() => parseSourceFeedback(sdoc(source), hdoc(invalid))).toThrow()
})
