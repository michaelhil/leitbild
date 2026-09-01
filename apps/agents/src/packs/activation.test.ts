import { describe, expect, test } from 'bun:test'
import { effectiveActivePacks, effectiveActivePackSet, isPackActiveInRoom } from './activation.ts'

// room.activePacks is the exact truth. Built-in and authored contributions
// are not Packs and therefore never appear here.

const room = (packs: string[]) => ({ getActivePacks: () => packs })

describe('effectiveActivePacks', () => {
  test('empty room → empty list (no implicit augmentation)', () => {
    expect(effectiveActivePacks(room([]))).toEqual([])
  })

  test('returns exactly what the room reports', () => {
    expect(effectiveActivePacks(room(['demos', 'pwr-ops', 'aviation'])))
      .toEqual(['demos', 'pwr-ops', 'aviation'])
  })

  test('preserves order verbatim', () => {
    expect(effectiveActivePacks(room(['z', 'a', 'm']))).toEqual(['z', 'a', 'm'])
  })
})

describe('effectiveActivePackSet', () => {
  test('mirrors room.activePacks as a Set', () => {
    const s = effectiveActivePackSet(room(['demos', 'aviation']))
    expect(s.has('demos')).toBe(true)
    expect(s.has('aviation')).toBe(true)
    expect(s.has('cafes')).toBe(false)
  })

  test('empty room → empty set', () => {
    expect(effectiveActivePackSet(room([])).size).toBe(0)
  })
})

describe('isPackActiveInRoom', () => {
  test('present in activePacks → true', () => {
    expect(isPackActiveInRoom(room(['demos', 'aviation']), 'demos')).toBe(true)
    expect(isPackActiveInRoom(room(['demos', 'aviation']), 'aviation')).toBe(true)
  })

  test('absent → false', () => {
    expect(isPackActiveInRoom(room([]), 'demos')).toBe(false)
    expect(isPackActiveInRoom(room(['aviation']), 'cafes')).toBe(false)
  })
})
