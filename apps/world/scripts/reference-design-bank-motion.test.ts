import { expect, test } from 'bun:test'
import { advanceBank, parseBankBasis, type BankState, type BankSupport } from './reference-design-bank-motion'

const basis = { referencePosition: .7, ordinaryRate_s: .002, insertionRate_s: .5, worthPerStroke: .1 }
const state: BankState = { position: .7, mode: 'MANUAL', requestedPosition: .8, released: false }
const held: BankSupport = { holdingVoltage: true, ordinaryDrive: true, releaseAvailable: true, insertionStop: 0 }

test('achieved motion respects finite rate, actual drive, exact travel endpoint and pause', () => {
  expect(advanceBank(basis, state, held, 1).state.position).toBeCloseTo(.702, 14)
  expect(advanceBank(basis, state, { ...held, ordinaryDrive: false }, 1).state.position).toBe(.7)
  const stop = advanceBank(basis, { ...state, requestedPosition: .701 }, held, 1)
  expect(stop.state.position).toBe(.701)
  expect(stop.segments.length).toBe(2)
  expect(stop.segments.reduce((s, p) => s + p.duration_s, 0)).toBe(1)
  expect(advanceBank(basis, state, { ...held, holdingVoltage: false }, 0).state).toEqual(state)
})

test('holding loss releases physical insertion without drive or software trip; failures differ', () => {
  const lost = { ...held, holdingVoltage: false, ordinaryDrive: false }
  const moving = advanceBank(basis, state, lost, .5)
  expect(moving.state.position).toBeCloseTo(.45, 14)
  expect(moving.state.mode).toBe('HOLD')
  expect(moving.state.requestedPosition).toBe(0)
  expect(moving.state.released).toBe(true)
  const failed = advanceBank(basis, state, { ...lost, releaseAvailable: false }, 2)
  expect(failed.state.position).toBe(.7)
  expect(failed.state.released).toBe(false)
  const obstructed = advanceBank(basis, state, { ...lost, insertionStop: .3 }, 2)
  expect(obstructed.state.position).toBe(.3)
  expect(obstructed.state.released).toBe(true)
  const ordinaryObstruction = advanceBank(basis, { ...state, position: .4, requestedPosition: 0 }, { ...held, insertionStop: .3 }, 100)
  expect(ordinaryObstruction.state.position).toBe(.3)
})

test('restoring hold does not recapture in travel or revive withdrawal; copies retain release', () => {
  const lost = { ...held, holdingVoltage: false }
  const a = advanceBank(basis, state, lost, .5).state
  const restored = advanceBank(basis, a, held, 2).state
  expect(restored.position).toBe(0)
  expect(restored.mode).toBe('HOLD')
  const reengaged = advanceBank(basis, restored, held, 1).state
  expect(reengaged).toEqual({ position: 0, mode: 'HOLD', requestedPosition: 0, released: false })
  expect(advanceBank(basis, JSON.parse(JSON.stringify(a)), held, 2).state).toEqual(restored)
  expect(a.position).toBeCloseTo(.45, 14)
  expect(() => advanceBank(basis, { ...state, position: 0, released: true }, held, 1)).toThrow()
})

test('subdivision preserves physical path and invalid records fail explicitly', () => {
  const support = { ...held, holdingVoltage: false, insertionStop: .2 }
  let split = { ...state }
  for (let i = 0; i < 20; i++) split = advanceBank(basis, split, support, .1).state
  expect(split).toEqual(advanceBank(basis, state, support, 2).state)
  for (const dt of [-1, NaN, Infinity]) expect(() => advanceBank(basis, state, held, dt)).toThrow()
  expect(() => advanceBank(basis, state, { ...held, insertionStop: .9 }, 1)).toThrow()
  const doc = '```reference-bank-motion\n' + JSON.stringify(basis) + '\n```\n'
  expect(parseBankBasis(doc)).toEqual(basis)
  expect(() => parseBankBasis(doc + doc)).toThrow()
  expect(() => parseBankBasis(doc.replace('0.002', '0'))).toThrow()
  expect(state.position).toBe(.7)
})
