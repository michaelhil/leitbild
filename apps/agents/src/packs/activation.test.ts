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
    expect(effectiveActivePacks(room(['demos', 'pwr-ops', 'site-survey'])))
      .toEqual(['demos', 'pwr-ops', 'site-survey'])
  })

  test('preserves order verbatim', () => {
    expect(effectiveActivePacks(room(['z', 'a', 'm']))).toEqual(['z', 'a', 'm'])
  })
})

describe('effectiveActivePackSet', () => {
  test('mirrors room.activePacks as a Set', () => {
    const s = effectiveActivePackSet(room(['demos', 'site-survey']))
    expect(s.has('demos')).toBe(true)
    expect(s.has('site-survey')).toBe(true)
    expect(s.has('cafes')).toBe(false)
  })

  test('empty room → empty set', () => {
    expect(effectiveActivePackSet(room([])).size).toBe(0)
  })
})

describe('isPackActiveInRoom', () => {
  test('present in activePacks → true', () => {
    expect(isPackActiveInRoom(room(['demos', 'site-survey']), 'demos')).toBe(true)
    expect(isPackActiveInRoom(room(['demos', 'site-survey']), 'site-survey')).toBe(true)
  })

  test('absent → false', () => {
    expect(isPackActiveInRoom(room([]), 'demos')).toBe(false)
    expect(isPackActiveInRoom(room(['site-survey']), 'cafes')).toBe(false)
  })
})
