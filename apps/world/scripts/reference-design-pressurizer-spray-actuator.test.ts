import { expect, test } from 'bun:test'
import { advanceControlledSpray, advanceManualSpray, type SprayState } from './reference-design-pressurizer-spray-actuator'

const clear = { opening: false, closing: false }
const supported = { actB: true, localOutputAvailable: true, obstruction: clear }
const initial: SprayState = { position: 0, retainedDemand: 0, outputValid: true }

test('finite stroke, target reversal and powered-motion duration', () => {
  const opening = advanceControlledSpray(initial, { ...supported, updateDemand: 1, dt_s: 0.5 })
  expect(opening.state.position).toBe(0.25)
  expect(opening.openingWork_J).toBe(500)
  const reversed = advanceControlledSpray(opening.state, { ...supported, updateDemand: 0.1, dt_s: 0.1 })
  expect(reversed.state.position).toBeCloseTo(0.2, 15)
  expect(reversed.openingWork_J).toBe(0)
  const finished = advanceControlledSpray(initial, { ...supported, updateDemand: 1, dt_s: 5 })
  expect(finished.state.position).toBe(1)
  expect(finished.motion_s).toBe(2)
  expect(finished.openingWork_J).toBe(2000)
})

test('support loss spring-closes, and restoration cannot revive stale intent', () => {
  const original = { position: 0.8, retainedDemand: 0.8, outputValid: true }
  const lost = advanceControlledSpray(original, { ...supported, actB: false, dt_s: 0.5 })
  expect(lost.state.position).toBeCloseTo(0.55, 15)
  expect(lost.state.retainedDemand).toBe(0.8)
  expect(lost.state.outputValid).toBe(false)
  expect(lost.openingWork_J).toBe(0)
  const recovered = advanceControlledSpray(lost.state, { ...supported, dt_s: 0.5 })
  expect(recovered.state.position).toBeCloseTo(0.3, 15)
  expect(recovered.effectiveTarget).toBe(0)
  expect(recovered.state.outputValid).toBe(false)
  expect(() => advanceControlledSpray(recovered.state, { ...supported, updateDemand: 0.8, dt_s: 1 })).toThrow()
  const copy = JSON.parse(JSON.stringify(recovered.state)) as SprayState
  const next = { ...supported, transferDemand: 0.6, dt_s: 0.4 }
  expect(advanceControlledSpray(copy, next)).toEqual(advanceControlledSpray(recovered.state, next))
  expect(advanceControlledSpray(copy, next).state.position).toBeCloseTo(0.5, 15)
  expect(advanceControlledSpray(copy, next).state.outputValid).toBe(true)
})

test('local output loss and directional obstruction remain physical', () => {
  const open = { position: 1, retainedDemand: 1, outputValid: true }
  const blocked = advanceControlledSpray(open, { ...supported, actB: false, dt_s: 5, obstruction: { opening: false, closing: true } })
  expect(blocked.state.position).toBe(1)
  expect(blocked.blocked).toBe(true)
  expect(blocked.state.outputValid).toBe(false)
  const released = advanceControlledSpray(blocked.state, { ...supported, dt_s: 1 })
  expect(released.state.position).toBe(0.5)
  expect(released.state.outputValid).toBe(false)
  const unavailable = advanceControlledSpray(open, { ...supported, localOutputAvailable: false, dt_s: 2 })
  expect(unavailable.state.position).toBe(0)
  expect(unavailable.state.outputValid).toBe(false)
  const stalled = advanceControlledSpray(initial, { ...supported, updateDemand: 1, dt_s: 0.5, obstruction: { opening: true, closing: false } })
  expect(stalled.state.position).toBe(0)
  expect(stalled.openingWork_J).toBe(500)
  expect(() => advanceControlledSpray(open, { ...supported, actB: false, transferDemand: 0, dt_s: 1 })).toThrow()
})

test('manual bypass retains independent setting and finite local travel', () => {
  const bypass = { position: 0.01, target: 0.01 }
  expect(advanceManualSpray(bypass, 100, clear).state).toEqual(bypass)
  expect(advanceManualSpray(bypass, 0.05, clear, 0).state.position).toBeCloseTo(0.005, 15)
  expect(advanceManualSpray(bypass, 0.1, clear, 0).state.position).toBe(0)
  expect(advanceManualSpray(bypass, 1, { opening: false, closing: true }, 0).state.position).toBe(0.01)
  expect(advanceManualSpray({ position: 0, target: 1 }, 10, clear).state.position).toBe(1)
  const moving = advanceManualSpray({ position: 0, target: 1 }, 2, clear).state
  expect(advanceManualSpray(moving, 10, clear, null).state).toEqual({ position: 0.2, target: 0.2 })
  const cancelled = advanceManualSpray(moving, 10, clear, null).state
  expect(advanceManualSpray(cancelled, 10, clear).state).toEqual(cancelled)
  expect(() => advanceManualSpray(bypass, 1, clear, 2)).toThrow()
})

test('invalid input is rejected, not silently clamped', () => {
  expect(() => advanceControlledSpray(initial, { ...supported, dt_s: -1 })).toThrow()
  expect(() => advanceControlledSpray({ ...initial, position: NaN }, { ...supported, dt_s: 1 })).toThrow()
  expect(() => advanceControlledSpray(initial, { ...supported, transferDemand: 1, updateDemand: 0, dt_s: 1 })).toThrow()
  expect(() => advanceControlledSpray(initial, { ...supported, updateDemand: 1.01, dt_s: 1 })).toThrow()
})
