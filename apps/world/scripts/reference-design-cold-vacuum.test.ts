import { expect, test } from 'bun:test'
import { floodedMachine, gasDisplacement, inletConductance, vacuumSelection } from './reference-design-cold-vacuum'

test('actual speed governs displacement; closing supply does not erase retained case evacuation', () => {
  expect(gasDisplacement(1)).toBe(5)
  expect(gasDisplacement(0)).toBe(0)
  expect(gasDisplacement(.5)).toBe(2.5)
  expect(inletConductance(1, true)).toBe(.5)
  expect(inletConductance(.25, true)).toBe(.125)
  expect(inletConductance(1, false)).toBe(0)
  expect(inletConductance(0, true)).toBe(0)
  expect(() => gasDisplacement(-1)).toThrow()
  expect(() => inletConductance(1.1, true)).toThrow()
})
test('physical retained flood amount selects a jam, not an invisible liquid sink', () => {
  expect(floodedMachine(0)).toBe(false)
  expect(floodedMachine(.004999)).toBe(false)
  expect(floodedMachine(.005)).toBe(true)
  expect(floodedMachine(.05)).toBe(true)
  expect(() => floodedMachine(.051)).toThrow()
  expect(vacuumSelection.bodyCapacity_J_K).toBe(1e7)
})
