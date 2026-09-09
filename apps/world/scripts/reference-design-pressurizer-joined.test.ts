import { expect, test } from 'bun:test'
import { parseJoinedPressurizer } from './reference-design-pressurizer-joined'

test('joined PZR case owns finite duration, resolution and explicit dry initial condition', () => {
  const input = { duration_s: 1, timeStep_s: 0.05, axialCells: 8, radialCells: 16, upperSuperheat_K: 2 }
  const document = (value: unknown) => '```reference-pressurizer-joined\n' + JSON.stringify(value) + '\n```'
  expect(parseJoinedPressurizer(document(input))).toEqual(input)
  expect(() => parseJoinedPressurizer(document({ ...input, timeStep_s: 2 }))).toThrow()
  expect(() => parseJoinedPressurizer(document({ ...input, upperSuperheat_K: 0 }))).toThrow()
  expect(() => parseJoinedPressurizer(document({ ...input, fixedPressure: true }))).toThrow()
  expect(() => parseJoinedPressurizer(document(input) + '\n' + document(input))).toThrow()
})
