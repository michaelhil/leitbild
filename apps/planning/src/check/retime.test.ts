import { describe, expect, test } from 'bun:test'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import type { CheckRow, CheckVariant } from './check.ts'
import { atHigh, judgeRetiming, rangedJobs } from './retime.ts'

// The pessimistic card's check (design §4.2): a re-timed schedule (same order and crews, nothing earlier) is
// judged at the high estimates by the checker, and the first rule it breaks, its job and by how much are
// the checker's own. Window Mon 16 Nov 2026 06:00Z to Wed 18 Nov 06:00Z; one operator and one helper
// around the clock. Every instant below is worked out beside it.
type Job = PlanInputs['jobs'][number]
const planner = { by: 'planner' as const }
const hours = (value: number, range?: { low: number; high: number }) => ({ value, unit: 'h' as const, calendar: 'working' as const, ...(range === undefined ? {} : { range }), origin: planner })
const onOps = (anyOf = ['ops']) => [{ anyOf, amount: 1, handover: false }]
const jobs: Job[] = [
  { key: 'T', title: 'Tag out X', kind: 'tag-out', equipment: ['X'], isolation: 'none', duration: hours(1), durationWith: [], needs: onOps(), continuous: true, checks: [], tags: [] },
  { key: 'W', title: 'Work inside X', kind: 'work', equipment: ['X'], isolation: 'inside', duration: hours(2, { low: 1, high: 4 }), durationWith: [], needs: onOps(['ops', 'helper']), continuous: true, checks: [], tags: [] },
  { key: 'R', title: 'Test X', kind: 'test', equipment: ['X'], isolation: 'none', duration: hours(1), durationWith: [], needs: onOps(), continuous: true, checks: [], tags: [] },
]
const limit = (key: string, value: number) => ({ kind: 'span-limit' as const, key, group: 'G', limit: { value, unit: 'h' as const }, singleEntry: true, words: `X back within ${value} h`, source: planner })
const due = (key: string, finishBy: string) => ({ kind: 'due' as const, key, job: 'R', finishBy, words: 'X back by then', source: planner })
const plan = (rules: PlanInputs['rules']): PlanInputs => planInputsSchema.parse({
  settings: { title: 'Re-timing', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-18T06:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [{ key: 'X', label: 'Item X', group: 'G', supportedBy: [] }], groups: [{ key: 'G', label: 'Group G' }],
  calendars: [{ key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner }],
  resources: ['ops', 'helper'].map(key => ({ key, label: key, kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner })),
  purchases: [], methods: [], jobs, links: [], rules,
  goals: [{ metric: 'span-over', scope: { groups: ['G'] }, tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
})
const none: CheckVariant = { methods: [], purchases: [] }
const at = (hour: number): string => new Date(Date.UTC(2026, 10, 16, 0, 0) + hour * 3_600_000).toISOString().replace('.000Z', 'Z')
const rowOf = (job: string, from: number, to: number, resource = 'ops'): CheckRow => ({ job, start: at(from), finish: at(to), uses: [{ resource, from: at(from), to: at(to) }] })
// Planned at the most likely 2 h: T 06:00Z-07:00Z, W 07:00Z-09:00Z, R 09:00Z-10:00Z (G out 4 h).
const planned = [rowOf('T', 6, 7), rowOf('W', 7, 9), rowOf('R', 9, 10)]
// W at its high 4 h, nothing earlier: W 07:00Z-11:00Z, R 11:00Z-12:00Z (G out 06:00Z-12:00Z, 6 h).
const retimed = [rowOf('T', 6, 7), rowOf('W', 7, 11), rowOf('R', 11, 12)]

describe('the ranged jobs and their high estimates', () => {
  test('only W has a range', () => {
    expect(rangedJobs(plan([]), none)).toEqual(['W'])
  })
  test('at high, W takes 4 h and nothing else changes', () => {
    const high = atHigh(plan([]), ['W'])
    expect(high.jobs.map(job => [job.key, job.duration.value])).toEqual([['T', 1], ['W', 4], ['R', 1]])
  })
})

describe('the outcome is the checker\'s', () => {
  test('a 5 h limit: G out 6 h breaks it at the test, by 1 h', () => {
    expect(judgeRetiming(plan([limit('L', 5)]), none, planned, retimed, ['W'])).toMatchObject({ ok: true, outcome: { holds: false, rule: 'L', job: 'R', by: { value: 1, unit: 'h' } } })
  })
  test('a 7 h limit holds', () => {
    expect(judgeRetiming(plan([limit('L', 7)]), none, planned, retimed, ['W'])).toMatchObject({ ok: true, outcome: { holds: true } })
  })
  test('a due time at 11:30Z: the test finishes at 12:00Z, 0.5 h late', () => {
    expect(judgeRetiming(plan([limit('L', 7), due('D', at(11.5))]), none, planned, retimed, ['W'])).toMatchObject({ ok: true, outcome: { holds: false, rule: 'D', job: 'R', by: { value: 0.5, unit: 'h' } } })
  })
  test('the first rule broken is the first in time: the 5 h limit runs out at 11:00Z, before the 11:30Z due', () => {
    expect(judgeRetiming(plan([due('D', at(11.5)), limit('L', 5)]), none, planned, retimed, ['W'])).toMatchObject({ ok: true, outcome: { holds: false, rule: 'L', job: 'R', by: { value: 1, unit: 'h' } } })
  })
  test("a what-if's extra rule is judged too: at most 4.5 h out, broken by 1.5 h", () => {
    const whatIf: CheckVariant = { ...none, also: [limit('A', 4.5)] }
    expect(judgeRetiming(plan([limit('L', 7)]), whatIf, planned, retimed, ['W'])).toMatchObject({ ok: true, outcome: { holds: false, rule: 'A', job: 'R', by: { value: 1.5, unit: 'h' } } })
  })
})

describe('what is not a re-timing is refused, never judged', () => {
  test('a job earlier than planned', () => {
    // planned half an hour later throughout; the "re-timing" brings T back to 06:00Z
    const later = [rowOf('T', 6.5, 7.5), rowOf('W', 7.5, 9.5), rowOf('R', 9.5, 10.5)]
    const result = judgeRetiming(plan([limit('L', 7)]), none, later, retimed, ['W'])
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.problems.join(' ')).toContain("'Tag out X'")
  })
  test('another crew', () => {
    const helped = retimed.map(entry => entry.job === 'W' ? rowOf('W', 7, 11, 'helper') : entry)
    const result = judgeRetiming(plan([limit('L', 7)]), none, planned, helped, ['W'])
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.problems.join(' ')).toContain("'Work inside X'")
  })
  test('a job missing from the re-timing', () => {
    expect(judgeRetiming(plan([limit('L', 7)]), none, planned, retimed.filter(entry => entry.job !== 'R'), ['W']).ok).toBe(false)
  })
  test('rows not lengthened to the high estimate do not match its durations', () => {
    expect(judgeRetiming(plan([limit('L', 7)]), none, planned, planned, ['W']).ok).toBe(false)
  })
  test('a job without a range has no high estimate', () => {
    expect(judgeRetiming(plan([limit('L', 7)]), none, planned, planned, ['T']).ok).toBe(false)
  })
})

describe('a re-timing that runs past the window is judged as the window', () => {
  // W at a high estimate of 50 h: W Mon 07:00Z to Wed 09:00Z, R Wed 09:00Z-10:00Z, past the window end Wed
  // 06:00Z. The work is judged on the plan's calendars continued past the window (the operator and helper
  // work around the clock); the first job past the end is W, and the work would end at R's finish, Wed 10:00Z.
  const long = (rules: PlanInputs['rules']): PlanInputs => {
    const base = plan(rules)
    return { ...base, jobs: base.jobs.map(job => job.key === 'W' ? { ...job, duration: { ...job.duration, range: { low: 1, high: 50 } } } : job) }
  }
  const past = [rowOf('T', 6, 7), rowOf('W', 7, 57), rowOf('R', 57, 58)]
  test('no rule breaks first: the window, at W, the work ending Wed 10:00Z', () => {
    expect(judgeRetiming(long([limit('L', 60)]), none, planned, past, ['W'])).toEqual({ ok: true, outcome: { holds: false, window: { by: at(58) }, job: 'W' } })
  })
  test('a rule that breaks before the window end comes first: G out 52 h runs past 7 h at Mon 13:00Z', () => {
    expect(judgeRetiming(long([limit('L', 7)]), none, planned, past, ['W'])).toMatchObject({ ok: true, outcome: { holds: false, rule: 'L', job: 'R', by: { value: 45, unit: 'h' } } })
  })
  test('rows past the window that do not match the high estimate are still refused', () => {
    expect(judgeRetiming(long([]), none, planned, [rowOf('T', 6, 7), rowOf('W', 7, 56), rowOf('R', 57, 58)], ['W']).ok).toBe(false)
  })
  test('a protection rule broken is still refused, never judged', () => {
    const shielded = { kind: 'protected' as const, key: 'P', equipment: ['X'], words: 'X is never worked', source: planner }
    expect(judgeRetiming(plan([shielded]), none, planned, retimed, ['W']).ok).toBe(false)
  })
})
