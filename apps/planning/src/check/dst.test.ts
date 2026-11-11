import { describe, expect, test } from 'bun:test'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { checkPlan, type CheckRow } from './check.ts'

// Daylight saving through the checker. Every instant is written by hand, never computed with Intl, so a
// shared misuse of the zone wrapper cannot make the checker agree with the compiler by accident.
// Europe/Oslo: CET (+01:00) until 2026-03-29 01:00Z, CEST (+02:00) until 2026-10-25 01:00Z, then CET.
const planner = { by: 'planner' as const }
const plan = (zone: string, window: { start: string; end: string }, jobs: PlanInputs['jobs'], links: PlanInputs['links'] = []): PlanInputs => planInputsSchema.parse({
  settings: { title: 'Daylight saving', timeZone: zone, window, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [], groups: [],
  calendars: [
    { key: 'day', label: 'Day shift', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '15:00' }], periods: [], except: [], source: planner },
    { key: 'night', label: 'Saturday night', weekly: [{ days: ['sat'], from: '22:00', to: '06:00' }], periods: [], except: [], source: planner },
    { key: 'office', label: 'Office hours', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' }], periods: [], except: [], source: planner },
    { key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner },
  ],
  resources: ['day', 'night', 'office', 'always'].map(calendar => ({ key: `${calendar}-crew`, label: `${calendar} crew`, kind: 'crew', count: 1, calendar, attributes: [], source: planner })),
  purchases: [], methods: [], jobs, links, rules: [],
  goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
})
const job = (key: string, crew: string, hours: number, continuous: boolean): PlanInputs['jobs'][number] => ({
  key, title: `Job ${key}`, kind: 'work', equipment: [], isolation: 'none', duration: { value: hours, unit: 'h', calendar: 'working', origin: planner },
  durationWith: [], needs: [{ anyOf: [crew], amount: 1, handover: false }], continuous, checks: [], tags: [],
})
const row = (key: string, start: string, finish: string, uses: Array<[string, string, string]>): CheckRow => ({ job: key, start, finish, uses: uses.map(([resource, from, to]) => ({ resource, from, to })) })
const codes = (result: ReturnType<typeof checkPlan>) => result.violations.map(violation => violation.code)

describe('spring forward, 29 March 2026', () => {
  // Fri 27 Mar 07:00 CET = 06:00Z to Tue 31 Mar 07:00 CEST = 05:00Z
  const window = { start: '2026-03-27T06:00:00Z', end: '2026-03-31T05:00:00Z' }
  test('a 12 h day-shift job keeps local hours: Fri 06:00Z-14:00Z, then Mon 05:00Z-09:00Z', () => {
    const inputs = plan('Europe/Oslo', window, [job('W', 'day-crew', 12, false)])
    const right = row('W', '2026-03-27T06:00:00Z', '2026-03-30T09:00:00Z', [['day-crew', '2026-03-27T06:00:00Z', '2026-03-27T14:00:00Z'], ['day-crew', '2026-03-30T05:00:00Z', '2026-03-30T09:00:00Z']])
    expect(checkPlan(inputs, { methods: [], purchases: [] }, [right]).violations).toEqual([])
    // the same wall hours with the winter offset kept (Mon 06:00Z-10:00Z) is an hour off
    const winter = row('W', '2026-03-27T06:00:00Z', '2026-03-30T10:00:00Z', [['day-crew', '2026-03-27T06:00:00Z', '2026-03-27T14:00:00Z'], ['day-crew', '2026-03-30T06:00:00Z', '2026-03-30T10:00:00Z']])
    const refused = checkPlan(inputs, { methods: [], purchases: [] }, [winter])
    expect(refused.feasible).toBe(false)
    expect(codes(refused)).toContain('finish-mismatch')
  })
  test('the Saturday night 22:00-06:00 is 7 h: 21:00Z to 04:00Z', () => {
    const fits = plan('Europe/Oslo', window, [job('N', 'night-crew', 7, true)])
    expect(checkPlan(fits, { methods: [], purchases: [] }, [row('N', '2026-03-28T21:00:00Z', '2026-03-29T04:00:00Z', [['night-crew', '2026-03-28T21:00:00Z', '2026-03-29T04:00:00Z']])]).violations).toEqual([])
    const long = plan('Europe/Oslo', window, [job('N', 'night-crew', 7.5, true)])
    expect(codes(checkPlan(long, { methods: [], purchases: [] }, [row('N', '2026-03-28T21:00:00Z', '2026-03-29T04:30:00Z', [['night-crew', '2026-03-28T21:00:00Z', '2026-03-29T04:00:00Z']])]))).toContain('not-continuous')
  })
  test('a 24 h lag is clock time: Sat 12:00Z plus 24 h is Sun 12:00Z (14:00 CEST), not the same wall time', () => {
    const inputs = plan('Europe/Oslo', window, [job('A', 'always-crew', 1, true), job('B', 'always-crew', 1, true)], [{ from: 'A', to: 'B', type: 'FS', lag: { value: 24, unit: 'h' } }])
    const a = row('A', '2026-03-28T11:00:00Z', '2026-03-28T12:00:00Z', [['always-crew', '2026-03-28T11:00:00Z', '2026-03-28T12:00:00Z']])
    const b = (start: string, finish: string) => row('B', start, finish, [['always-crew', start, finish]])
    expect(checkPlan(inputs, { methods: [], purchases: [] }, [a, b('2026-03-29T12:00:00Z', '2026-03-29T13:00:00Z')]).violations).toEqual([])
    // Sun 13:00 CEST = 11:00Z is the same wall time as A's finish, but only 23 h later
    expect(codes(checkPlan(inputs, { methods: [], purchases: [] }, [a, b('2026-03-29T11:00:00Z', '2026-03-29T12:00:00Z')]))).toEqual(['link'])
  })
  test('the planner reads local times in the words', () => {
    const inputs = plan('Europe/Oslo', window, [job('W', 'day-crew', 12, false)])
    const late = row('W', '2026-03-27T06:00:00Z', '2026-03-30T09:30:00Z', [['day-crew', '2026-03-27T06:00:00Z', '2026-03-27T14:00:00Z'], ['day-crew', '2026-03-30T05:00:00Z', '2026-03-30T09:00:00Z']])
    const words = checkPlan(inputs, { methods: [], purchases: [] }, [late]).violations.find(violation => violation.code === 'finish-mismatch')?.words
    expect(words).toContain('Mon 30 Mar 11:00')   // 09:00Z in CEST
  })
})

describe('fall back, 25 October 2026', () => {
  // Fri 23 Oct 07:00 CEST = 05:00Z to Tue 27 Oct 07:00 CET = 06:00Z
  const window = { start: '2026-10-23T05:00:00Z', end: '2026-10-27T06:00:00Z' }
  test('a 12 h day-shift job: Fri 05:00Z-13:00Z, then Mon 06:00Z-10:00Z', () => {
    const inputs = plan('Europe/Oslo', window, [job('W', 'day-crew', 12, false)])
    const right = row('W', '2026-10-23T05:00:00Z', '2026-10-26T10:00:00Z', [['day-crew', '2026-10-23T05:00:00Z', '2026-10-23T13:00:00Z'], ['day-crew', '2026-10-26T06:00:00Z', '2026-10-26T10:00:00Z']])
    expect(checkPlan(inputs, { methods: [], purchases: [] }, [right]).violations).toEqual([])
  })
  test('the Saturday night is 9 h: 20:00Z to 05:00Z', () => {
    const inputs = plan('Europe/Oslo', window, [job('N', 'night-crew', 9, true)])
    expect(checkPlan(inputs, { methods: [], purchases: [] }, [row('N', '2026-10-24T20:00:00Z', '2026-10-25T05:00:00Z', [['night-crew', '2026-10-24T20:00:00Z', '2026-10-25T05:00:00Z']])]).violations).toEqual([])
  })
})

describe('a half-hour zone on the 30-minute grid', () => {
  test('Asia/Kolkata office hours 09:00-17:00 are 03:30Z-11:30Z', () => {
    // Mon 16 Nov 2026, +05:30 all year
    const inputs = plan('Asia/Kolkata', { start: '2026-11-16T00:00:00Z', end: '2026-11-17T00:00:00Z' }, [job('K', 'office-crew', 8, true)])
    expect(checkPlan(inputs, { methods: [], purchases: [] }, [row('K', '2026-11-16T03:30:00Z', '2026-11-16T11:30:00Z', [['office-crew', '2026-11-16T03:30:00Z', '2026-11-16T11:30:00Z']])]).violations).toEqual([])
  })
})
