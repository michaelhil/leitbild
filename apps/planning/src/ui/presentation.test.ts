import { describe, expect, test } from 'bun:test'
import { barPosition, elapsed, fittedHorizon, movePriority, optionalSecond } from './presentation.ts'

describe('Planning presentation', () => {
  test('timeline uses the retained horizon and clips older baseline bars to its bounds', () => {
    expect(barPosition({ start: 100, end: 200 }, { start: 125, end: 175 })).toEqual({ left: 25, width: 50 })
    expect(barPosition({ start: 100, end: 200 }, { start: 0, end: 120 })).toEqual({ left: 0, width: 20 })
    expect(barPosition({ start: 100, end: 200 }, { start: 180, end: 250 })).toEqual({ left: 80, width: 20 })
  })
  test('priority edits preserve every activity exactly once and leave bounds unchanged', () => {
    expect(movePriority(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(movePriority(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(movePriority(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
  })
  test('the schedule view fits retained placements without changing the planning horizon', () => {
    const horizon = { start: 0, end: 10800 }
    expect(fittedHorizon(horizon, [{ end: 3000 }])).toEqual({ start: 0, end: 3240 })
    expect(fittedHorizon(horizon, [])).toEqual(horizon)
    expect(fittedHorizon(horizon, [{ end: 10800 }])).toEqual(horizon)
  })
  test('elapsed labels and form parsing preserve seconds and distinguish blank from zero', () => {
    expect(elapsed(3661)).toBe('1h 1m 1s')
    expect(optionalSecond('')).toBeUndefined()
    expect(optionalSecond('0')).toBe(0)
    expect(() => optionalSecond('1.5')).toThrow('whole seconds')
    expect(() => optionalSecond('-1')).toThrow('whole seconds')
  })
})
