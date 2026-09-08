import { expect, test } from 'bun:test'
import { parseFilmBasis } from './reference-design-pressurizer-film'
const block = (value: unknown) => '```reference-pressurizer-film\n'+JSON.stringify(value)+'\n```\n'
test('finite film reference declares resolution and duration, not a fitted drain delay', () => {
  const value = { duration_s: 30, axialCells: 40, timeStep_s: .1 }
  expect(parseFilmBasis(block(value))).toEqual(value)
  expect(() => parseFilmBasis(block({...value, initialFilm_m: 1e-6}))).toThrow()
  expect(() => parseFilmBasis(block({...value, timeStep_s: 31}))).toThrow()
  expect(() => parseFilmBasis(block({...value, axialCells: 0}))).toThrow()
  expect(() => parseFilmBasis(block(value)+block(value))).toThrow()
})
