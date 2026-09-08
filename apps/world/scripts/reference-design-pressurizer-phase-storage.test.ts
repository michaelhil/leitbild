import { expect, test } from 'bun:test'
import { parsePhaseStorageBasis } from './reference-design-pressurizer-phase-storage'
const page = (value: unknown) => '```reference-pressurizer-phase-storage\n'+JSON.stringify(value)+'\n```\n'
test('phase storage reference requires explicit finite thermal challenges without extra physics switches', () => {
  const value = { wallReheatAboveInitialVapor_K: 5, coldLowerOffset_K: 20 }
  expect(parsePhaseStorageBasis(page(value))).toEqual(value)
  expect(() => parsePhaseStorageBasis(page({...value, coldLowerOffset_K: 0}))).toThrow()
  expect(() => parsePhaseStorageBasis(page({...value, condensationRelaxation: 1}))).toThrow()
  expect(() => parsePhaseStorageBasis(page(value)+page(value))).toThrow()
})
