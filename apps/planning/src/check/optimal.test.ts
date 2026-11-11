import { describe, expect, test } from 'bun:test'
import { planInputsSchema, planSchema, type PlanInputs } from '../plan/schema.ts'
import { verifyBound, verifyOptimality } from './optimal.ts'
import { recheckOption } from './recheck.ts'

// "Proven optimal" is confirmed only when the checker's own bound reaches the value. Window Mon 16 Nov
// 06:00Z-12:00Z, one operator around the clock; every figure below is worked out in the comment beside it.
const planner = { by: 'planner' as const }
const job = (key: string, kind: 'tag-out' | 'work' | 'test' = 'work', equipment: string[] = []): PlanInputs['jobs'][number] => ({
  key, title: key, kind, equipment, isolation: kind === 'work' && equipment.length > 0 ? 'inside' : 'none', duration: { value: 1, unit: 'h', calendar: 'working', origin: planner },
  durationWith: [], needs: [{ anyOf: ['ops'], amount: 1, handover: false }], continuous: true, checks: [], tags: [],
})
const plan = (fields: Partial<PlanInputs>) => planInputsSchema.parse({
  settings: { title: 'Optimality', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-16T12:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [], groups: [],
  calendars: [{ key: 'always', label: 'Always', weekly: [], periods: [{ start: '2026-11-16T06:00:00Z', end: '2026-11-16T12:00:00Z' }], except: [], source: planner }],
  resources: [{ key: 'ops', label: 'Operator', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner }],
  purchases: [], methods: [], jobs: [], links: [], rules: [], goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
  ...fields,
})
const run = { grid: '30min' as const, engine: 'double', formulation: 'f', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
const optimal = (metric: 'finish' | 'extra-cost' | 'span-over' | 'unavailable-hours' | 'lateness', value: number, unit = 'h') =>
  ({ word: 'validated feasible' as const, goals: [{ word: 'proven optimal' as const, goal: 0, value, unit, bound: { value, source: 'logic+calendars' as const, certificate: { kind: 'zero' as const } } }], run })
const none = { methods: [], purchases: [] }

describe('"proven optimal" is re-derived by the checker', () => {
  // A then B, linked: 1 h each, so nothing finishes before 2 h after the window opens.
  const chain = plan({ jobs: [job('A'), job('B')], links: [{ from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'h' } }] })
  test('finish: a claim of 2 h is confirmed; a claim of 3 h is not (the bound is 2 h)', () => {
    expect(verifyOptimality(chain, none, optimal('finish', 2))).toEqual([{ goal: 0, claimed: 2, bound: 2, proves: true }])
    expect(verifyOptimality(chain, none, optimal('finish', 3))).toEqual([{ goal: 0, claimed: 3, bound: 2, proves: false }])
  })
  test("extra cost: the chosen method's parts are charged in every plan", () => {
    const priced = plan({ methods: [{ key: 'M', label: 'Method', options: [{ key: 'a', label: 'A', fixedCost: 10 }, { key: 'b', label: 'B', fixedCost: 20 }] }], goals: [{ metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } }] })
    const variant = { methods: [{ choice: 'M', option: 'a' }], purchases: [] }
    expect(verifyOptimality(priced, variant, optimal('extra-cost', 10, 'NOK'))[0]?.proves).toBe(true)
    expect(verifyOptimality(priced, variant, optimal('extra-cost', 15, 'NOK'))[0]?.proves).toBe(false)
  })
  // Item X in group G: tag 1 h, inside work 1 h, test 1 h, all on the one operator: out at least 3 h.
  const item = plan({
    equipment: [{ key: 'X', label: 'X', group: 'G', supportedBy: [] }], groups: [{ key: 'G', label: 'Group G' }],
    jobs: [job('T', 'tag-out', ['X']), job('W', 'work', ['X']), job('R', 'test', ['X'])],
  })
  test('span-over and unavailable hours: the least outage of the item, 3 h, net of the threshold', () => {
    const span = { ...item, goals: [{ metric: 'span-over' as const, scope: { groups: ['G'] }, threshold: { value: 1, unit: 'h' }, tolerance: { value: 0, unit: 'h' } }] }
    expect(verifyOptimality(span, none, optimal('span-over', 2))[0]).toMatchObject({ bound: 2, proves: true })   // 3 h - 1 h
    const unavailable = { ...item, goals: [{ metric: 'unavailable-hours' as const, tolerance: { value: 0, unit: 'h' } }] }
    expect(verifyOptimality(unavailable, none, optimal('unavailable-hours', 3))[0]).toMatchObject({ bound: 3, proves: true })
    expect(verifyOptimality(unavailable, none, optimal('unavailable-hours', 3.5))[0]).toMatchObject({ bound: 3, proves: false })
  })
  test('lateness: B can finish no earlier than 2 h in, so 1 h past a target at 1 h in', () => {
    const late = plan({ ...chain, jobs: [job('A'), { ...job('B'), target: { finishBy: '2026-11-16T07:00:00Z', words: 'Hoped for by 08:00' } }], goals: [{ metric: 'lateness', tolerance: { value: 0, unit: 'min' } }] })
    expect(verifyOptimality(late, none, optimal('lateness', 60, 'min'))[0]).toMatchObject({ bound: 60, proves: true })
  })
  test('recheck shows an unconfirmed "proven optimal" goal as best found; the option stays usable', () => {
    const rows = [
      { job: 'A', start: '2026-11-16T06:00:00Z', finish: '2026-11-16T07:00:00Z', uses: [{ resource: 'ops', from: '2026-11-16T06:00:00Z', to: '2026-11-16T07:00:00Z' }], float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } } },
      { job: 'B', start: '2026-11-16T08:00:00Z', finish: '2026-11-16T09:00:00Z', uses: [{ resource: 'ops', from: '2026-11-16T08:00:00Z', to: '2026-11-16T09:00:00Z' }], float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } } },
    ]
    const stored = planSchema.parse({
      id: '00000000-0000-4000-8000-000000000003', workspaceId: '00000000-0000-4000-8000-0000000000aa', revision: 1, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', inputs: chain,
      options: { at: '2026-11-11T00:00:00Z', by: { kind: 'agent' }, options: [{ key: 'o', label: 'Option', variant: none, status: optimal('finish', 3), rows, metrics: [], inputsRevision: 1 }] },
      baselines: [], changes: [], droppedChanges: 0,
    })
    // B finishes at 3 h, but 2 h is possible: "proven optimal" at 3 h cannot be confirmed
    expect(recheckOption(stored, stored.options!.options[0]!, 'f')).toMatchObject({ usable: true, bestFoundGoals: [0] })
  })
})

describe("lane S's port and goal order", () => {
  const two = plan({ jobs: [job('A'), job('B')], links: [{ from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'h' } }],
    goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }, { metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } }] })
  test('verifyBound confirms a bound the checker reaches and names the gap otherwise', () => {
    expect(verifyBound(two, none, 0, { value: 2 })).toMatchObject({ proves: true, reasons: [] })
    expect(verifyBound(two, none, 0, { value: 2.5 })).toMatchObject({ proves: false, checkerBound: 2 })
    expect(verifyBound(two, none, 1, { value: 0 }).proves).toBe(true)   // nothing is charged in every plan
  })
  test('once a goal is not confirmed, no later "proven optimal" goal is', () => {
    const status = { word: 'validated feasible' as const, run, goals: [
      { word: 'proven optimal' as const, goal: 0, value: 3, unit: 'h', bound: { value: 3, source: 'logic+calendars' as const, certificate: { kind: 'zero' as const } } },
      { word: 'proven optimal' as const, goal: 1, value: 0, unit: 'NOK', bound: { value: 0, source: 'fixed-costs' as const, certificate: { kind: 'zero' as const } } },
    ] }
    expect(verifyOptimality(two, none, status).map(entry => entry.proves)).toEqual([false, false])
  })
})

describe('a keep-free rule over crews bounds the finish', () => {
  // Two trucks a and b (single units, 24/7), two 1 h deliveries either can do, "keep one truck free":
  // only one truck may be busy at a time, so the deliveries go in turn and nothing finishes before 2 h.
  const trucks = (rules: PlanInputs['rules']) => plan({
    resources: ['a', 'b'].map(key => ({ key, label: `Truck ${key}`, kind: 'crew' as const, count: 1, calendar: 'always', attributes: [], source: planner })),
    jobs: ['north', 'south'].map(key => ({ ...job(key), needs: [{ anyOf: ['a', 'b'], amount: 1, handover: false }] })),
    rules,
  })
  const keepOneFree = [{ kind: 'keep-in-service' as const, key: 'one-free', members: [{ resource: 'a' }, { resource: 'b' }], atLeast: 1, words: 'Keep one truck free at all times', source: planner }]
  test('with the rule the bound is 2 h, so a 2 h finish is proven optimal', () => {
    expect(verifyBound(trucks(keepOneFree), none, 0, { value: 2 })).toMatchObject({ proves: true, checkerBound: 2 })
  })
  test('without it the trucks can run together and the bound is 1 h', () => {
    expect(verifyBound(trucks([]), none, 0, { value: 2 })).toMatchObject({ proves: false, checkerBound: 1 })
  })
  test('the rule counts only while it holds: kept free for the first hour only, the bound is 1.5 h', () => {
    // 08:00-09:00 one delivery-hour of capacity a half-hour... capacity is 1 truck for the first hour, 2 after:
    // 2 truck-hours of work fit by 1 h (one truck) + 0.5 h (both trucks) = 1.5 h
    const firstHour = [{ ...keepOneFree[0]!, during: { start: '2026-11-16T06:00:00Z', end: '2026-11-16T07:00:00Z' } }]
    expect(verifyBound(trucks(firstHour), none, 0, { value: 1.5 })).toMatchObject({ proves: true, checkerBound: 1.5 })
  })
})

describe("lane S's walk-4 plan, solved by the real search", () => {
  // The same plan as lane S's R4-3 test: window Thu 3 Sep 2026 08:00Z-14:00Z, trucks a and b around the
  // clock, two 1 h deliveries, "keep one truck free". The search finds 2 h; the checker's bound is 2 h.
  test('its 2 h finish is confirmed "proven optimal"', async () => {
    const { generate } = await import('../solve/generate.ts')
    const { searchEngine } = await import('../solve/search.ts')
    const { laneKCheck, laneKVerify, laneKVerifyBound } = await import('../solve/fixtures/lane-k.ts')
    const inputs = planInputsSchema.parse({
      settings: { title: 'Two deliveries', timeZone: 'Europe/Oslo', window: { start: '2026-09-03T08:00:00Z', end: '2026-09-03T14:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
      equipment: [], groups: [],
      calendars: [{ key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner }],
      resources: ['a', 'b'].map(key => ({ key, label: `Truck ${key}`, kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner })),
      purchases: [], methods: [], links: [],
      rules: [{ kind: 'keep-in-service', key: 'one-free', members: [{ resource: 'a' }, { resource: 'b' }], atLeast: 1, words: 'Keep one truck free at all times', source: planner }],
      jobs: ['north', 'south'].map(key => ({ ...job(key), title: `Deliver ${key}`, needs: [{ anyOf: ['a', 'b'], amount: 1, handover: false }] })),
      goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
    })
    const result = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs, revision: 1, previous: null, input: {}, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, evals: 200 })
    const option = result.optionSet.options[0]!
    expect(verifyOptimality(inputs, option.variant, option.status)).toEqual(option.status.word === 'validated feasible' && option.status.goals[0]?.word === 'proven optimal' ? [{ goal: 0, claimed: 2, bound: 2, proves: true }] : [])
    expect(option.status.word === 'validated feasible' ? option.status.goals[0]?.word : undefined).toBe('proven optimal')
  }, 60_000)
})
