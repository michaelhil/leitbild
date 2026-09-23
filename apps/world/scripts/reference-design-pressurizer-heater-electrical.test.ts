import { describe, expect, test } from 'bun:test'
import { advanceHeaterContact, heaterCoilSupported, heaterElectricPower, splitHeaterRequest, type ContactState } from './reference-design-pressurizer-heater-electrical'

const healthy = { kind: 'healthy' } as const
const base = { request_W: 3000000, voltage_V: 10000, feederClosed: true, isolatorClosed: true, normal: healthy, backup: healthy }
const closed: ContactState = { closed: true, targetClosed: true, elapsed_s: 0 }
const open: ContactState = { closed: false, targetClosed: false, elapsed_s: 0 }

describe('bounded heater electrical selection', () => {
  test('continuous nominal split and rejected invalid requests', () => {
    expect(splitHeaterRequest(0)).toEqual({ normal_W: 0, backup_W: 0 })
    expect(splitHeaterRequest(120000)).toEqual({ normal_W: 120000, backup_W: 0 })
    expect(splitHeaterRequest(120001)).toEqual({ normal_W: 120000, backup_W: 1 })
    expect(splitHeaterRequest(3000000)).toEqual({ normal_W: 120000, backup_W: 2880000 })
    for (const request of [-1, NaN, Infinity, 3000001]) expect(() => splitHeaterRequest(request)).toThrow()
  })

  test('actual resistive voltage power, faults and real conducting barriers', () => {
    expect(heaterElectricPower(base).total_W).toBe(3000000)
    expect(heaterElectricPower({ ...base, voltage_V: 11000 }).total_W).toBeCloseTo(3630000, 6)
    expect(heaterElectricPower({ ...base, voltage_V: 5000 }).total_W).toBe(750000)
    expect(heaterElectricPower({ ...base, voltage_V: 0 }).total_W).toBe(0)
    const failedOn = { ...base, request_W: 0, backup: { kind: 'failed-on' } as const }
    expect(heaterElectricPower(failedOn).total_W).toBe(2880000)
    expect(heaterElectricPower({ ...failedOn, isolatorClosed: false }).total_W).toBe(0)
    expect(heaterElectricPower({ ...failedOn, feederClosed: false }).total_W).toBe(0)
    expect(heaterElectricPower({ ...base, normal: { kind: 'failed-off' }, backup: { kind: 'stuck', duty: 0.25 } }).total_W).toBe(720000)
    expect(() => heaterElectricPower({ ...base, backup: { kind: 'stuck', duty: 1.1 } })).toThrow()
    expect(() => heaterElectricPower({ ...base, voltage_V: -1 })).toThrow()
  })

  test('powered actual majority, not logical cause flags', () => {
    for (let bits = 0; bits < 8; bits++) {
      const permits: [boolean, boolean, boolean] = [Boolean(bits & 1), Boolean(bits & 2), Boolean(bits & 4)]
      expect(heaterCoilSupported(true, true, true, permits)).toBe(permits.filter(Boolean).length >= 2)
      expect(heaterCoilSupported(false, true, true, permits)).toBe(false)
      expect(heaterCoilSupported(true, false, true, permits)).toBe(false)
      expect(heaterCoilSupported(true, true, false, permits)).toBe(false)
    }
  })

  test('spring opening keeps failed-on power until actual contact break', () => {
    const first = advanceHeaterContact(closed, true, false, 0.02)
    expect(first.state.closed).toBe(true)
    expect(first.transitionAfter_s).toBeNull()
    expect(heaterElectricPower({ ...base, request_W: 0, normal: { kind: 'failed-on' }, isolatorClosed: first.state.closed }).total_W).toBe(120000)
    const copy = JSON.parse(JSON.stringify(first.state)) as ContactState
    const last = advanceHeaterContact(copy, true, false, 0.04)
    expect(last.state.closed).toBe(false)
    expect(last.transitionAfter_s).toBeCloseTo(0.03, 15)
    expect(last).toEqual(advanceHeaterContact(first.state, true, false, 0.04))
    expect(heaterElectricPower({ ...base, isolatorClosed: last.state.closed }).total_W).toBe(0)
  })

  test('target reversal cancels unfinished timing; closing needs continuous support', () => {
    const opening = advanceHeaterContact(closed, false, false, 0.02).state
    expect(advanceHeaterContact(opening, true, true, 0.01).state).toEqual(closed)
    const closing = advanceHeaterContact(open, true, true, 0.02).state
    expect(advanceHeaterContact(closing, true, false, 0.01).state).toEqual(open)
    const restarted = advanceHeaterContact(open, true, true, 0.049)
    expect(restarted.state.closed).toBe(false)
    expect(advanceHeaterContact(restarted.state, true, true, 0.002).state.closed).toBe(true)
    expect(advanceHeaterContact(open, true, true, 0.05).transitionAfter_s).toBe(0.05)
    expect(advanceHeaterContact(closed, false, false, 1, true).state.closed).toBe(true)
    expect(advanceHeaterContact(open, true, true, 1, true).state.closed).toBe(false)
    expect(() => advanceHeaterContact(open, true, true, -1)).toThrow()
    expect(() => advanceHeaterContact({ ...open, elapsed_s: 0.01 }, true, true, 1)).toThrow()
  })
})
