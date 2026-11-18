import { describe, expect, test } from 'bun:test'
import { formatOffset, isTimeZone, localParts, localToInstant, zoneDataFingerprint, zoneOffGridOffset, zoneOffsetMs } from './zone.ts'

// Every expected instant below is written by hand from the published rules: Europe/Oslo moves from
// +01:00 to +02:00 at 2026-03-29 01:00 UTC and back at 2026-10-25 01:00 UTC; America/New_York moves
// from -05:00 to -04:00 at 2026-03-08 07:00 UTC; Asia/Kolkata is +05:30 and Asia/Kathmandu +05:45.
const at = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()
const hour = 3_600_000

describe('time zones', () => {
  test('offsets either side of each change', () => {
    expect(zoneOffsetMs('Europe/Oslo', at('2026-03-29T00:59:59Z'))).toBe(1 * hour)
    expect(zoneOffsetMs('Europe/Oslo', at('2026-03-29T01:00:00Z'))).toBe(2 * hour)
    expect(zoneOffsetMs('Europe/Oslo', at('2026-10-25T00:59:59Z'))).toBe(2 * hour)
    expect(zoneOffsetMs('Europe/Oslo', at('2026-10-25T01:00:00Z'))).toBe(1 * hour)
    expect(zoneOffsetMs('America/New_York', at('2026-03-08T06:59:59Z'))).toBe(-5 * hour)
    expect(zoneOffsetMs('America/New_York', at('2026-03-08T07:00:00Z'))).toBe(-4 * hour)
    expect(zoneOffsetMs('UTC', at('2026-03-29T01:00:00Z'))).toBe(0)
  })

  test('local parts of an instant', () => {
    expect(localParts('Europe/Oslo', at('2026-03-29T01:00:00Z'))).toEqual({ year: 2026, month: 3, day: 29, hour: 3, minute: 0, second: 0, weekday: 'sun' })
    expect(localParts('Europe/Oslo', at('2026-11-16T06:00:00Z'))).toEqual({ year: 2026, month: 11, day: 16, hour: 7, minute: 0, second: 0, weekday: 'mon' })
    expect(localParts('Asia/Kolkata', at('2026-11-15T23:00:00Z'))).toEqual({ year: 2026, month: 11, day: 16, hour: 4, minute: 30, second: 0, weekday: 'mon' })
  })

  test('ordinary wall times', () => {
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 11, day: 16, hour: 7, minute: 0 }))).toBe('2026-11-16T06:00:00.000Z')
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 7, day: 1, hour: 7, minute: 0 }))).toBe('2026-07-01T05:00:00.000Z')
    expect(iso(localToInstant('Asia/Kolkata', { year: 2026, month: 11, day: 16, hour: 7, minute: 0 }))).toBe('2026-11-16T01:30:00.000Z')
  })

  test('a wall time in a gap gives the first instant after the gap', () => {
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 3, day: 29, hour: 2, minute: 0 }))).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 3, day: 29, hour: 2, minute: 30 }))).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 3, day: 29, hour: 3, minute: 0 }))).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 3, day: 29, hour: 1, minute: 30 }))).toBe('2026-03-29T00:30:00.000Z')
    expect(iso(localToInstant('America/New_York', { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }))).toBe('2026-03-08T07:00:00.000Z')
  })

  test('a wall time in an overlap gives the earlier instant', () => {
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 10, day: 25, hour: 2, minute: 0 }))).toBe('2026-10-25T00:00:00.000Z')
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 10, day: 25, hour: 2, minute: 30 }))).toBe('2026-10-25T00:30:00.000Z')
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 10, day: 25, hour: 3, minute: 0 }))).toBe('2026-10-25T02:00:00.000Z')
    expect(iso(localToInstant('Europe/Oslo', { year: 2026, month: 10, day: 25, hour: 1, minute: 30 }))).toBe('2026-10-24T23:30:00.000Z')
  })

  test('zone names', () => {
    for (const zone of ['Europe/Oslo', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/New_York', 'UTC']) expect(isTimeZone(zone)).toBe(true)
    for (const zone of ['Mars/Base', '+01:00', '-05:00', '', 'Oslo']) expect(isTimeZone(zone)).toBe(false)
  })

  test('Kolkata fits the 30 min grid; Kathmandu is refused at 30 min and fits 30 s', () => {
    const from = at('2026-11-16T00:00:00Z'), to = at('2026-11-21T00:00:00Z')
    expect(zoneOffGridOffset('Asia/Kolkata', 1_800_000, from, to)).toBeUndefined()
    expect(zoneOffGridOffset('Europe/Oslo', 1_800_000, at('2026-03-27T00:00:00Z'), at('2026-03-31T00:00:00Z'))).toBeUndefined()
    expect(zoneOffGridOffset('Asia/Kathmandu', 1_800_000, from, to)).toBe(20_700_000)
    expect(zoneOffGridOffset('Asia/Kathmandu', 30_000, from, to)).toBeUndefined()
  })

  test('offsets in words', () => {
    expect(formatOffset(20_700_000)).toBe('+05:45')
    expect(formatOffset(-4 * hour)).toBe('-04:00')
    expect(formatOffset(0)).toBe('+00:00')
  })

  test('the time-zone data is named by the ICU version and a known Oslo transition', () => {
    expect(process.versions.icu).toBeString()
    expect(zoneDataFingerprint()).toBe(`icu ${process.versions.icu}; Europe/Oslo 2026-03-29T01:00:00.000Z +01:00>+02:00`)
  })
})
