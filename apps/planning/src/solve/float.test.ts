import { describe, expect, test } from 'bun:test'
import { planInputsSchema } from '../plan/schema.ts'
import { compile } from './compile.ts'
import { dateSchedule } from './date.ts'
import { makeDecoder, precedenceOrder, prepare } from './decode.ts'
import { totalFloat, withFloat } from './float.ts'

// Six jobs on a day shift (Mon-Fri 07:00-15:00, Europe/Oslo, CET) with an overnight break, and a
// 30 h span limit on group G. Window Mon 16 Nov 07:00 to Thu 19 Nov 07:00. Every expected time and
// float below is computed by hand in the comments.
const job = (key: string, kind: 'tag-out' | 'work' | 'test', hours: number, resource: string, extra: Record<string, unknown> = {}) => ({
  key, title: key, kind, equipment: kind === 'work' && extra.isolation === 'none' ? [] : ['X'], isolation: 'inside', duration: { value: hours, unit: 'h', calendar: 'working', origin: { by: 'planner' } },
  durationWith: [], needs: [{ anyOf: [resource], amount: 1, handover: false }], continuous: kind !== 'work', checks: [], tags: [], ...extra,
  ...(kind === 'work' ? {} : { isolation: 'none' }),
})
const inputs = planInputsSchema.parse({
  settings: { title: 'Float fixture', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-19T06:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [{ key: 'X', label: 'Pump X', group: 'G', supportedBy: [] }],
  groups: [{ key: 'G', label: 'Group G' }],
  calendars: [
    { key: 'day', label: 'Day', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '15:00' }], periods: [], except: [], source: { by: 'planner' } },
    { key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: { by: 'planner' } },
  ],
  resources: [
    { key: 'crew', label: 'Crew', kind: 'crew', count: 1, calendar: 'day', attributes: [], source: { by: 'planner' } },
    { key: 'crew2', label: 'Second crew', kind: 'crew', count: 1, calendar: 'day', attributes: [], source: { by: 'planner' } },
    { key: 'operator', label: 'Operator', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: { by: 'planner' } },
  ],
  purchases: [], methods: [],
  jobs: [
    job('T', 'tag-out', 1, 'operator'),
    job('A', 'work', 4, 'crew'),
    job('B', 'work', 6, 'crew'),
    job('C', 'test', 1, 'operator'),
    job('D', 'work', 3, 'crew2', { isolation: 'none' }),
    job('E', 'work', 2, 'crew2', { isolation: 'none' }),
  ],
  links: [
    { from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'h' } },
    { from: 'D', to: 'E', type: 'FS', lag: { value: 0, unit: 'h' } },
  ],
  rules: [{ kind: 'span-limit', key: 'R', group: 'G', limit: { value: 30, unit: 'h' }, singleEntry: true, words: 'X back within 30 h.', source: { by: 'planner' } }],
  goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }],
  world: { refreshedAt: null, facts: [] },
})
const local = (text: string) => new Date(`${text}+01:00`).toISOString()

describe('total float to the nearest binding limit', () => {
  const compiled = compile(inputs, { methods: [], buy: 'allowed' })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems))
  const prep = prepare(compiled.problem)
  const decoder = makeDecoder(prep)
  const decoded = decoder.decode(precedenceOrder(prep, [...prep.topo]), compiled.problem.activities.map(() => 0))
  decoder.justify(decoded)
  const rows = withFloat(dateSchedule(prep, compiled.index, decoded), totalFloat(prep, compiled.index, decoded), compiled.index)
  const row = (key: string) => rows.find(entry => entry.job === key)!

  test('the earliest schedule is the hand-made one', () => {
    expect(decoded.penalty).toBe(0)
    // T Mon 07:00-08:00 (operator, 24/7); A 4 h Mon 08:00-12:00; B 6 h after A: Mon 12:00-15:00 and,
    // after the night, Tue 07:00-10:00; C 1 h Tue 10:00-11:00. D Mon 07:00-10:00 and E Mon 10:00-12:00.
    expect(rows.map(entry => [entry.job, entry.start, entry.finish])).toEqual([
      ['T', local('2026-11-16T07:00:00'), local('2026-11-16T08:00:00')],
      ['A', local('2026-11-16T08:00:00'), local('2026-11-16T12:00:00')],
      ['B', local('2026-11-16T12:00:00'), local('2026-11-17T10:00:00')],
      ['C', local('2026-11-17T10:00:00'), local('2026-11-17T11:00:00')],
      ['D', local('2026-11-16T07:00:00'), local('2026-11-16T10:00:00')],
      ['E', local('2026-11-16T10:00:00'), local('2026-11-16T12:00:00')],
    ])
  })

  test('cooling-chain style jobs are limited by the span, the others by the window end', () => {
    // Span R opens at T's start, Mon 07:00, so C must be back by Mon 07:00 + 30 h = Tue 13:00.
    // C: latest start Tue 12:00; float = 24/7 hours Tue 10:00-12:00 = 2 h.
    expect(row('C').float).toEqual({ workingHours: 2, limitedBy: { kind: 'span-limit', rule: 'R' } })
    // B: must end by C's latest start, Tue 12:00: 6 day hours back are Tue 07:00-12:00 (5) and
    // Mon 14:00-15:00 (1), so latest start Mon 14:00; float = day hours Mon 12:00-14:00 = 2 h.
    expect(row('B').float).toEqual({ workingHours: 2, limitedBy: { kind: 'span-limit', rule: 'R' } })
    // A: must end by B's latest start, Mon 14:00: latest start Mon 10:00; float Mon 08:00-10:00 = 2 h.
    expect(row('A').float).toEqual({ workingHours: 2, limitedBy: { kind: 'span-limit', rule: 'R' } })
    // T: must end by A's latest start, Mon 10:00: latest start Mon 09:00; float = 24/7 Mon 07:00-09:00 = 2 h.
    expect(row('T').float).toEqual({ workingHours: 2, limitedBy: { kind: 'span-limit', rule: 'R' } })
    // E: window ends Thu 07:00; the last day shift before it ends Wed 15:00, so latest start Wed 13:00.
    // Float = day hours from Mon 10:00 to Wed 13:00: Mon 5 + Tue 8 + Wed 6 = 19 h.
    expect(row('E').float).toEqual({ workingHours: 5 + 8 + 6, limitedBy: { kind: 'window-end' } })
    // D: must end by E's latest start, Wed 13:00: latest start Wed 10:00.
    // Float = day hours from Mon 07:00 to Wed 10:00: Mon 8 + Tue 8 + Wed 3 = 19 h.
    expect(row('D').float).toEqual({ workingHours: 8 + 8 + 3, limitedBy: { kind: 'window-end' } })
  })

  test('no float is negative', () => {
    for (const entry of rows) expect(entry.float.workingHours).toBeGreaterThanOrEqual(0)
  })
})
