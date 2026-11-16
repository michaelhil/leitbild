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

describe("a what-if's lead: only the lead may be proven, on its own bound (fix B)", () => {
  // Item X in group G: tag 1 h, inside work 1 h, test 1 h, all on the one operator, chained by the brackets:
  // G is out at least 3 h and nothing finishes before 3 h. Goals: 0 finish, 1 G's span over 1 h.
  const goals: PlanInputs['goals'] = [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }, { metric: 'span-over', scope: { groups: ['G'] }, threshold: { value: 1, unit: 'h' }, tolerance: { value: 0, unit: 'h' } }]
  const leadPlan = plan({
    equipment: [{ key: 'X', label: 'X', group: 'G', supportedBy: [] }], groups: [{ key: 'G', label: 'Group G' }],
    jobs: [job('T', 'tag-out', ['X']), job('W', 'work', ['X']), job('R', 'test', ['X'])], goals,
  })
  const proven = (goal: number, value: number, unit = 'h') => ({ word: 'proven optimal' as const, goal, value, unit, bound: { value, source: 'logic+calendars' as const, certificate: { kind: 'zero' as const } } })
  const found = (goal: number, value: number, unit = 'h') => ({ word: 'best found under budget' as const, goal, value, unit })
  const groupLine = (word: 'proven optimal' | 'best found under budget', value: number, unit = 'h') => word === 'proven optimal'
    ? { word, group: 'G', value, unit, bound: { value, source: 'logic+calendars' as const, certificate: { kind: 'least-span' as const, spans: [{ group: 'G', hours: unit === 'min' ? value / 60 : value }] } } }
    : { word, group: 'G', value, unit }

  test('lead {goal: 1}: its span, 2 h over the threshold, is proven on its own bound; a claim on goal 0 is not', () => {
    // goal 0 at 3 h would reach its bound (3 h), but under a lead on goal 1 only goal 1 may be proven
    const status = { word: 'validated feasible' as const, run, goals: [proven(0, 3), proven(1, 2)], lead: { goal: 1 } }
    expect(verifyOptimality(leadPlan, none, status)).toEqual([{ goal: 0, claimed: 3, bound: 3, proves: false }, { goal: 1, claimed: 2, bound: 2, proves: true }])
  })
  test('lead {goal: 1}: goal 0 best found does not break the lead\'s proof (the order rule is replaced)', () => {
    const status = { word: 'validated feasible' as const, run, goals: [found(0, 4), proven(1, 2)], lead: { goal: 1 } }
    expect(verifyOptimality(leadPlan, none, status)).toEqual([{ goal: 1, claimed: 2, bound: 2, proves: true }])
  })
  test('lead {group: G}: the group line is checked on the least span of G, 3 h, threshold 0', () => {
    const status = (line: ReturnType<typeof groupLine>) => ({ word: 'validated feasible' as const, run, goals: [found(0, 3), found(1, 2)], lead: line })
    expect(verifyOptimality(leadPlan, none, status(groupLine('proven optimal', 3)))).toEqual([{ group: 'G', claimed: 3, bound: 3, proves: true }])
    expect(verifyOptimality(leadPlan, none, status(groupLine('proven optimal', 4)))).toEqual([{ group: 'G', claimed: 4, bound: 3, proves: false }])
    expect(verifyOptimality(leadPlan, none, status(groupLine('proven optimal', 180, 'min')))).toEqual([{ group: 'G', claimed: 180, bound: 180, proves: true }])
    expect(verifyOptimality(leadPlan, none, status(groupLine('best found under budget', 3)))).toEqual([])
  })
  test('lead {group: G}: no plan goal may be proven, even one that reaches its bound', () => {
    const status = { word: 'validated feasible' as const, run, goals: [proven(0, 3), found(1, 2)], lead: groupLine('proven optimal', 3) }
    expect(verifyOptimality(leadPlan, none, status)).toEqual([{ goal: 0, claimed: 3, bound: 3, proves: false }, { group: 'G', claimed: 3, bound: 3, proves: true }])
  })
  test("verifyBound takes the group lead as its goal: G's least span, 3 h (180 min)", () => {
    expect(verifyBound(leadPlan, none, { group: 'G', unit: 'h' }, { value: 3 })).toMatchObject({ proves: true, checkerBound: 3 })
    expect(verifyBound(leadPlan, none, { group: 'G', unit: 'min' }, { value: 180 })).toMatchObject({ proves: true, checkerBound: 180 })
    expect(verifyBound(leadPlan, none, { group: 'G', unit: 'h' }, { value: 3.5 })).toMatchObject({ proves: false, checkerBound: 3 })
    expect(verifyBound(leadPlan, none, { group: 'NONE', unit: 'h' }, { value: 0 })).toMatchObject({ proves: false })
  })
  describe('recheck: the group lead\'s value is the checker\'s own span:G figure', () => {
    // T 06:00Z-07:00Z, W 07:00Z-08:00Z, R 08:00Z-09:00Z: G is out 06:00Z-09:00Z, span:G = 3 h; finish 3 h.
    const rows = [['T', 6], ['W', 7], ['R', 8]].map(([key, hour]) => {
      const start = `2026-11-16T${String(hour).padStart(2, '0')}:00:00Z`, finish = `2026-11-16T${String(Number(hour) + 1).padStart(2, '0')}:00:00Z`
      return { job: String(key), start, finish, uses: [{ resource: 'ops', from: start, to: finish }], float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } } }
    })
    const stored = (line: ReturnType<typeof groupLine>) => planSchema.parse({
      id: '00000000-0000-4000-8000-000000000005', workspaceId: '00000000-0000-4000-8000-0000000000aa', revision: 1, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', inputs: leadPlan,
      options: { at: '2026-11-11T00:00:00Z', by: { kind: 'agent' }, options: [{ key: 'g', label: 'G first', variant: { ...none, lead: { group: 'G' } }, status: { word: 'validated feasible', run, goals: [found(0, 3), found(1, 2)], lead: line }, rows, metrics: [], inputsRevision: 1 }] },
      baselines: [], changes: [], droppedChanges: 0,
    })
    test('proven at 3 h, its own span: usable, the lead confirmed', () => {
      const plan = stored(groupLine('proven optimal', 3))
      expect(recheckOption(plan, plan.options!.options[0]!, 'f')).toMatchObject({ usable: true, reasons: [], bestFoundGoals: [], bestFoundLead: false })
    })
    test('a lead value below the span the rows give (2.5 h of 3 h) is not the checker\'s figure: not usable', () => {
      // the bound (3 h) "reaches" 2.5 h, so only the figure check catches it
      const plan = stored(groupLine('proven optimal', 2.5))
      expect(recheckOption(plan, plan.options!.options[0]!, 'f')).toMatchObject({ usable: false, reasons: ['lead-figure'], bestFoundLead: true })
    })
  })
})
