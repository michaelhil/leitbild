import { expect, test } from 'bun:test'
import { parseCondensationTemporal } from './reference-design-condensation-temporal.ts'

test('source observations are strict, unique, ordered and explicit about fluid', () => {
  const input: ReturnType<typeof parseCondensationTemporal> = {
    design: 'LD-01-condensation-temporal',
    observations: ['upper', 'lower'].map(id => ({ id, fluid: 'R113', pressure_bar: 2,
      subcooling_K: 14.4, Re0: 750, Pr: 6.7, Ja: 11,
      readings: [{ FoTimes10000: [1.38, 1.50], beta: [.72, .77] }],
    })),
  }
  const doc = (value: unknown) => '```reference-condensation-temporal\n' + JSON.stringify(value) + '\n```\n'
  expect(parseCondensationTemporal(doc(input))).toEqual(input)
  expect(() => parseCondensationTemporal('')).toThrow()
  expect(() => parseCondensationTemporal(doc(input) + doc(input))).toThrow()
  expect(() => parseCondensationTemporal(doc({ ...input, extra: true }))).toThrow()
  const mutate = (field: string, value: unknown) => ({ ...input,
    observations: input.observations.map((o, i) => i ? o : { ...o, [field]: value }) })
  expect(() => parseCondensationTemporal(doc(mutate('fluid', 'water')))).toThrow()
  expect(() => parseCondensationTemporal(doc(mutate('Re0', 0)))).toThrow()
  expect(() => parseCondensationTemporal(doc(mutate('id', 'lower')))).toThrow()
  expect(() => parseCondensationTemporal(doc(mutate('readings', [input.observations[0]!.readings[0], input.observations[0]!.readings[0]])))).toThrow()
  expect(() => parseCondensationTemporal(doc(mutate('readings', [{ FoTimes10000: [2, 1], beta: [.3, .4] }])))).toThrow()
  expect(() => parseCondensationTemporal(doc(mutate('readings', [{ FoTimes10000: [1, 2], beta: [.9, 1.1] }])))).toThrow()
})
