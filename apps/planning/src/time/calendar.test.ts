import { describe, expect, test } from 'bun:test'
import { expandCalendar, workingMs, type CalendarGrid, type CalendarInput } from './calendar.ts'

// Expected instants and slot indexes are written by hand. Europe/Oslo: CET (+01:00) until
// 2026-03-29 01:00 UTC, CEST (+02:00) until 2026-10-25 01:00 UTC.
const halfHour = 1_800_000
const hour = 3_600_000
const at = (iso: string) => Date.parse(iso)
const calendar = (fields: Partial<CalendarInput>): CalendarInput => ({ key: 'c', weekly: [], periods: [], except: [], ...fields })
const grid = (zone: string | null, origin: string, hours: number, slotMs = halfHour): CalendarGrid => ({ zone, slotMs, origin: at(origin), slots: hours * hour / slotMs })
const expand = (input: CalendarInput, on: CalendarGrid) => {
  const result = expandCalendar(input, on)
  if (!result.ok) throw new Error(JSON.stringify(result.problem))
  return result.work
}
const workingRuns = (work: Uint8Array): Array<[number, number]> => {
  const runs: Array<[number, number]> = []
  work.forEach((slot, index) => {
    const last = runs.at(-1)
    if (slot === 1 && last !== undefined && last[1] === index) last[1] = index + 1
    else if (slot === 1) runs.push([index, index + 1])
  })
  return runs
}

describe('calendar expansion', () => {
  test('the Saturday 22:00-06:00 night is 9 h when clocks go back and 7 h when they go forward', () => {
    const night = calendar({ weekly: [{ days: ['sat'], from: '22:00', to: '06:00' }] })
    // Sat 24 Oct 22:00 CEST = 20:00Z to Sun 25 Oct 06:00 CET = 05:00Z; origin 12:00Z
    const autumn = expand(night, grid('Europe/Oslo', '2026-10-24T12:00:00Z', 24))
    expect(workingMs(autumn, halfHour)).toBe(9 * hour)
    expect(workingRuns(autumn)).toEqual([[16, 34]])
    // Sat 28 Mar 22:00 CET = 21:00Z to Sun 29 Mar 06:00 CEST = 04:00Z; origin 12:00Z
    const spring = expand(night, grid('Europe/Oslo', '2026-03-28T12:00:00Z', 24))
    expect(workingMs(spring, halfHour)).toBe(7 * hour)
    expect(workingRuns(spring)).toEqual([[18, 32]])
  })

  test('a whole Sunday is 23 h in March and 25 h in October', () => {
    const sunday = calendar({ weekly: [{ days: ['sun'], from: '00:00', to: '00:00' }] })
    // Sun 29 Mar 00:00 CET = 28 Mar 23:00Z to Mon 30 Mar 00:00 CEST = 29 Mar 22:00Z
    const march = expand(sunday, grid('Europe/Oslo', '2026-03-28T12:00:00Z', 48))
    expect(workingRuns(march)).toEqual([[22, 68]])
    // Sun 25 Oct 00:00 CEST = 24 Oct 22:00Z to Mon 26 Oct 00:00 CET = 25 Oct 23:00Z
    const october = expand(sunday, grid('Europe/Oslo', '2026-10-24T12:00:00Z', 48))
    expect(workingRuns(october)).toEqual([[20, 70]])
  })

  test('a day shift keeps its local hours across the change', () => {
    const day = calendar({ weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '15:00' }] })
    // origin Thu 26 Mar 00:00Z, 6 days. Thu 26 and Fri 27: 06:00Z-14:00Z. Mon 30 and Tue 31: 05:00Z-13:00Z.
    const work = expand(day, grid('Europe/Oslo', '2026-03-26T00:00:00Z', 144))
    expect(workingMs(work, halfHour)).toBe(32 * hour)
    expect(workingRuns(work)).toEqual([[12, 28], [60, 76], [202, 218], [250, 266]])
  })

  test('a boundary inside a gap moves to the end of the gap; one inside an overlap takes the earlier instant', () => {
    const early = calendar({ weekly: [{ days: ['sun'], from: '02:00', to: '04:00' }] })
    // 29 Mar: 02:00 does not exist -> 01:00Z; 04:00 CEST = 02:00Z: 1 h
    const march = expand(early, grid('Europe/Oslo', '2026-03-29T00:00:00Z', 6))
    expect(workingRuns(march)).toEqual([[2, 4]])
    // 25 Oct: 02:00 happens twice -> the CEST one, 00:00Z; 04:00 CET = 03:00Z: 3 h
    const october = expand(early, grid('Europe/Oslo', '2026-10-25T00:00:00Z', 6))
    expect(workingRuns(october)).toEqual([[0, 6]])
  })

  test('Kolkata day shifts sit on the 30 min grid; Kathmandu ones are refused there and fit 30 s', () => {
    const day = calendar({ key: 'day', weekly: [{ days: ['mon'], from: '07:00', to: '15:00' }] })
    // Mon 16 Nov 07:00 IST = 01:30Z to 15:00 IST = 09:30Z; origin 00:00Z
    expect(workingRuns(expand(day, grid('Asia/Kolkata', '2026-11-16T00:00:00Z', 24)))).toEqual([[3, 19]])
    const refused = expandCalendar(day, grid('Asia/Kathmandu', '2026-11-16T00:00:00Z', 24))
    expect(refused).toEqual({ ok: false, problem: { code: 'calendar_off_grid', calendar: 'day', part: 'weekly', at: '2026-11-16T01:15:00.000Z', local: '2026-11-16 07:00 to 2026-11-16 15:00' } })
    // Mon 16 Nov 07:00 NPT = 01:15Z to 15:00 NPT = 09:15Z, on the 30 s grid: slots 150 to 1110
    const fine = expand(day, grid('Asia/Kathmandu', '2026-11-16T00:00:00Z', 24, 30_000))
    expect(workingRuns(fine)).toEqual([[150, 1110]])
  })

  test('one-off periods on the 30 s grid; off the 30 min grid they are refused', () => {
    const joins = calendar({ key: 'joins-08053', periods: [{ start: '2026-09-03T08:05:30Z', end: '2026-09-03T08:30:00Z' }] })
    const work = expand(joins, grid(null, '2026-09-03T08:00:00Z', 0.5, 30_000))
    expect(workingRuns(work)).toEqual([[11, 60]])
    expect(expandCalendar(joins, grid(null, '2026-09-03T08:00:00Z', 1))).toEqual({
      ok: false, problem: { code: 'calendar_off_grid', calendar: 'joins-08053', part: 'periods', at: '2026-09-03T08:05:30.000Z' },
    })
  })

  test('except removes working time', () => {
    const day = calendar({ weekly: [{ days: ['mon', 'tue'], from: '07:00', to: '15:00' }], except: [{ start: '2026-11-17T06:00:00Z', end: '2026-11-17T14:00:00Z' }] })
    // Mon 16 Nov 06:00Z-14:00Z only; origin 00:00Z
    expect(workingRuns(expand(day, grid('Europe/Oslo', '2026-11-16T00:00:00Z', 48)))).toEqual([[12, 28]])
  })

  test('time outside the grid is clipped; weekly time needs a zone', () => {
    const long = calendar({ periods: [{ start: '2026-11-15T23:59:45Z', end: '2026-11-16T03:00:00Z' }] })
    expect(workingRuns(expand(long, grid(null, '2026-11-16T00:00:00Z', 2)))).toEqual([[0, 4]])
    expect(expandCalendar(calendar({ key: 'day', weekly: [{ days: ['mon'], from: '07:00', to: '15:00' }] }), grid(null, '2026-11-16T00:00:00Z', 24)))
      .toEqual({ ok: false, problem: { code: 'calendar_needs_zone', calendar: 'day' } })
    expect(() => expandCalendar(long, { zone: null, slotMs: halfHour, origin: at('2026-11-16T00:15:00Z'), slots: 4 })).toThrow(RangeError)
  })
})
