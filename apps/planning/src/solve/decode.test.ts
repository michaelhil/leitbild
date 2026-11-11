import { describe, expect, test } from 'bun:test'
import { planInputsSchema } from '../plan/schema.ts'
import { compile } from './compile.ts'
import { dateSchedule } from './date.ts'
import { makeDecoder, precedenceOrder, prepare } from './decode.ts'

// SS and FF lags count working progress (controls review P1, P2; coordinator decision). Day shift
// Mon-Fri 07:00-15:00 Europe/Oslo (CET); every expected time is worked out by hand in the comments.
const plan = (links: unknown[], open: { hours: number; notBefore: string }, clean: { hours: number }) => planInputsSchema.parse({
  settings: { title: 'Lags', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-20T14:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [], groups: [],
  calendars: [{ key: 'day', label: 'Day', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '15:00' }], periods: [], except: [], source: { by: 'planner' } }],
  resources: ['crew-o', 'crew-c'].map(key => ({ key, label: key, kind: 'crew', count: 1, calendar: 'day', attributes: [], source: { by: 'planner' } })),
  purchases: [], methods: [],
  jobs: [
    { key: 'OPEN', title: 'Open', kind: 'work', equipment: [], isolation: 'none', duration: { value: open.hours, unit: 'h', calendar: 'working', origin: { by: 'planner' } }, durationWith: [], needs: [{ anyOf: ['crew-o'], amount: 1, handover: false }], continuous: false, notBefore: { at: open.notBefore, words: 'Released', source: { by: 'planner' } }, checks: [], tags: [] },
    { key: 'CLEAN', title: 'Clean', kind: 'work', equipment: [], isolation: 'none', duration: { value: clean.hours, unit: 'h', calendar: 'working', origin: { by: 'planner' } }, durationWith: [], needs: [{ anyOf: ['crew-c'], amount: 1, handover: false }], continuous: false, checks: [], tags: [] },
  ],
  links, rules: [], goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
})
const schedule = (inputs: ReturnType<typeof plan>) => {
  const compiled = compile(inputs, { methods: [], buy: 'allowed' })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems))
  const prep = prepare(compiled.problem)
  const decoded = makeDecoder(prep).decode(precedenceOrder(prep, [...prep.topo]), compiled.problem.activities.map(() => 0))
  return Object.fromEntries(dateSchedule(prep, compiled.index, decoded).map(row => [row.job, [row.start, row.finish]]))
}
const local = (text: string) => new Date(`${text}+01:00`).toISOString()
const lag = (type: 'SS' | 'FF', hours: number) => ({ from: 'OPEN', to: 'CLEAN', type, lag: { value: hours, unit: 'h' } })

describe('SS and FF lags count working progress', () => {
  test('SS 2 h: the successor waits for 2 h of the predecessor\'s work, across the night', () => {
    // OPEN released Mon 14:00 works Mon 14:00-15:00 and Tue 07:00-10:00. It has done 2 h at Tue 08:00
    // (1 h on Monday, 1 h on Tuesday), so CLEAN starts Tue 08:00, not Tue 07:00 as clock time would allow.
    const rows = schedule(plan([lag('SS', 2)], { hours: 4, notBefore: local('2026-11-16T14:00:00') }, { hours: 8 }))
    expect(rows.OPEN).toEqual([local('2026-11-16T14:00:00'), local('2026-11-17T10:00:00')])
    expect(rows.CLEAN![0]).toBe(local('2026-11-17T08:00:00'))
  })

  test('FF 1 h: at least 1 h of the successor\'s work falls after the predecessor\'s finish', () => {
    // OPEN released Mon 11:00 works Mon 11:00-15:00. CLEAN (2 h) started at t works [t, 15:00) and then
    // Tuesday; its work after 15:00 is 2 h - (15:00 - t) >= 1 h, so t >= Mon 14:00. (Clock time would
    // accept Mon 13:30: finish Tue 07:30 is more than 1 h after Mon 15:00, with only 0.5 h of work after it.)
    const rows = schedule(plan([lag('FF', 1)], { hours: 4, notBefore: local('2026-11-16T11:00:00') }, { hours: 2 }))
    expect(rows.OPEN).toEqual([local('2026-11-16T11:00:00'), local('2026-11-16T15:00:00')])
    expect(rows.CLEAN).toEqual([local('2026-11-16T14:00:00'), local('2026-11-17T08:00:00')])
  })

  test('FS stays clock time: a 2 h wait runs overnight', () => {
    // OPEN Mon 11:00-15:00; FS 2 h ends Mon 17:00, outside the shift; CLEAN starts Tue 07:00.
    const rows = schedule(plan([{ ...lag('SS', 0), type: 'FS', lag: { value: 2, unit: 'h' } }], { hours: 4, notBefore: local('2026-11-16T11:00:00') }, { hours: 2 }))
    expect(rows.CLEAN![0]).toBe(local('2026-11-17T07:00:00'))
  })
})

// A keep-in-service rule never makes the decoder place a job it cannot slot (coordinator, after or's lead):
// a ready opener the rule blocks at every slot waits until an open outage closes; when nothing else can go
// first, the plan is reported unplaceable (a deadlock) and the opener is not placed.
const pair = (extraLinks: unknown[]) => planInputsSchema.parse({
  settings: { title: 'Pair', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-17T06:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: ['A', 'B'].map(key => ({ key, label: `Pump ${key}`, supportedBy: [], function: 'feed' })), groups: [],
  calendars: [{ key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: { by: 'planner' } }],
  resources: [{ key: 'crew', label: 'Crew', kind: 'crew', count: 2, calendar: 'always', attributes: [], source: { by: 'planner' } }],
  purchases: [], methods: [],
  jobs: ['A', 'B'].flatMap(item => (['tag-out', 'work', 'test'] as const).map(kind => ({
    key: `${item}-${kind}`, title: `${item} ${kind}`, kind, equipment: [item], isolation: kind === 'work' ? 'inside' : 'none',
    duration: { value: kind === 'work' ? 2 : 1, unit: 'h', calendar: 'working', origin: { by: 'planner' } }, durationWith: [],
    needs: [{ anyOf: ['crew'], amount: 1, handover: false }], continuous: true, checks: [], tags: [],
  }))),
  links: extraLinks,
  rules: [{ kind: 'keep-in-service', key: 'K', members: [{ equipment: 'A' }, { equipment: 'B' }], atLeast: 1, words: 'One pump in service.', source: { by: 'planner' } }],
  goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
})
const decodeIn = (inputs: ReturnType<typeof pair>, order: readonly string[]) => {
  const compiled = compile(inputs, { methods: [], buy: 'allowed' })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems))
  const prep = prepare(compiled.problem)
  const list = precedenceOrder(prep, order.map(key => compiled.index.jobs.indexOf(key)))
  const decoded = makeDecoder(prep).decode(list, compiled.problem.activities.map(() => 0))
  const at = (key: string) => decoded.start[compiled.index.jobs.indexOf(key)]!
  return { decoded, at, H: prep.H }
}

describe('keep-in-service: a blocked opener waits, a deadlock is reported', () => {
  const order = ['A-tag-out', 'B-tag-out', 'A-work', 'A-test', 'B-work', 'B-test']
  test('B is tagged only after A is back, though the list puts B second', () => {
    // A out Mon 07:00-08:00 (tag), 08:00-10:00 (work), 10:00-11:00 (test): back at 11:00, slot 8.
    // B's tag-out waits for it: 11:00-12:00, work 12:00-14:00, test 14:00-15:00. Nothing late.
    const { decoded, at } = decodeIn(pair([]), order)
    expect(decoded.penalty).toBe(0)
    expect([at('A-tag-out'), at('A-test'), at('B-tag-out'), at('B-test')]).toEqual([0, 6, 8, 14])
  })

  test('when A cannot come back before B is tagged, the plan is a deadlock and B is not placed', () => {
    const { decoded, at, H } = decodeIn(pair([{ from: 'B-tag-out', to: 'A-test', type: 'FS', lag: { value: 0, unit: 'h' } }]), order)
    expect(decoded.penalty).toBeGreaterThan(0)
    expect(decoded.note).toBe('deadlock: K blocks every ready job')
    expect(at('B-tag-out')).toBe(H)
    expect(at('A-test')).toBe(H)
  })

  test("or's stuck twin v3 schedule decodes with no penalty; U1 CTF2 waits for CTF1's test (slot 156)", async () => {
    const { twinPlan, twinV3Options } = await import('../../tests/harness/twin-plan.ts')
    const bench = await Bun.file(new URL('./fixtures/twin-v3.json', import.meta.url)).json()
    const stuck = await Bun.file(new URL('./fixtures/twin-v3-stuck-schedule.json', import.meta.url)).json()
    const twin = twinPlan(bench, twinV3Options(bench))
    const compiled = compile(twin.inputs, { methods: [...twin.variant.methods], buy: [...twin.variant.purchases] })
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems))
    const prep = prepare(compiled.problem)
    const list = precedenceOrder(prep, [...prep.topo].sort((x, y) => stuck.schedule.start[x] - stuck.schedule.start[y] || x - y))
    const decoded = makeDecoder(prep).decode(list, stuck.schedule.mode)
    const at = (key: string) => compiled.problem.activities.findIndex(activity => activity.id === key)
    expect(decoded.penalty).toBe(0)
    expect(decoded.finish[at('U1-CTF1-RTS')]).toBe(156)
    expect(decoded.start[at('U1-CTF2-TAG')]).toBeGreaterThanOrEqual(156)
  })
})
