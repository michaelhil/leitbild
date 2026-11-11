import { describe, expect, test } from 'bun:test'
import { planInputsSchema, planSchema, type PlanInputs } from '../plan/schema.ts'
import { checkPlan, type CheckRow, type CheckVariant } from './check.ts'
import { recheckOption } from './recheck.ts'
import { verifyCertificate } from './certificate.ts'

// Small plans written by hand. Window Mon 16 Nov 2026 07:00 to Wed 18 Nov 07:00 Europe/Oslo (CET, +01:00),
// so local = UTC + 1 h throughout. Every expected instant below is worked out in the comment beside it.
type Job = PlanInputs['jobs'][number]
const planner = { by: 'planner' as const }
const hours = (value: number) => ({ value, unit: 'h' as const, calendar: 'working' as const, origin: planner })
const ops = (amount = 1) => [{ anyOf: ['ops'], amount, handover: false }]
const tag = (key: string, equipment: string[]): Job => ({ key, title: `Tag out ${equipment.join(', ')}`, kind: 'tag-out', equipment, isolation: 'none', duration: hours(1), durationWith: [], needs: ops(), continuous: true, checks: [], tags: [] })
const testJob = (key: string, equipment: string[]): Job => ({ key, title: `Test ${equipment.join(', ')}`, kind: 'test', equipment, isolation: 'none', duration: hours(1), durationWith: [], needs: ops(), continuous: true, checks: [], tags: [] })
const work = (key: string, item: string, length: number, continuous = false): Job => ({ key, title: `Work on ${item}`, kind: 'work', equipment: [item], isolation: 'inside', duration: hours(length), durationWith: [], needs: [{ anyOf: ['fitter'], amount: 1, handover: false }], continuous, checks: [], tags: [] })
const item = (key: string, supportedBy: string[] = [], group?: string) => ({ key, label: `Item ${key}`, supportedBy, ...(group === undefined ? {} : { group }) })

const plan = (fields: Partial<PlanInputs>): PlanInputs => planInputsSchema.parse({
  settings: { title: 'Check test', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-18T06:00:00Z' }, dataDate: '2026-11-12T09:00:00Z', grid: '30min', currency: 'NOK', run: null },
  equipment: [], groups: [],
  calendars: [
    { key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner },
    { key: 'day', label: 'Day shift', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '15:00' }], periods: [], except: [], source: planner },
    { key: 'none', label: 'Nothing booked', weekly: [], periods: [], except: [], source: planner },
  ],
  resources: [
    { key: 'ops', label: 'Operators', kind: 'crew', count: 2, calendar: 'always', attributes: [], source: planner },
    { key: 'fitter', label: 'Fitters', kind: 'crew', count: 1, crewSize: 3, calendar: 'day', attributes: [], source: planner },
  ],
  purchases: [], methods: [], jobs: [], links: [], rules: [],
  goals: [{ metric: 'unavailable-hours', tolerance: { value: 0, unit: 'h' } }],
  world: { refreshedAt: null, facts: [] },
  ...fields,
})
const noVariant: CheckVariant = { methods: [], purchases: [] }
const row = (job: string, start: string, finish: string, uses: CheckRow['uses']): CheckRow => ({ job, start, finish, uses })
/** A one-hour job on one operator, 30-min grid. */
const opsRow = (job: string, start: string): CheckRow => {
  const finish = new Date(Date.parse(start) + 3_600_000).toISOString().replace('.000Z', 'Z')
  return row(job, start, finish, [{ resource: 'ops', from: start, to: finish }])
}
/** Violation codes, sorted, so a test names what it expects and not the order it was found in. */
const codes = (result: { violations: ReadonlyArray<{ code: string }> }) => result.violations.map(violation => violation.code).sort()
const keepOne = (key: string, members: string[]) => ({ kind: 'keep-in-service' as const, key, members: members.map(equipment => ({ equipment })), atLeast: 1, words: `Keep at least one of ${members.join(' and ')} in service`, source: planner })

describe('the checker catches the unsafe plans', () => {
  // Two redundant trains, a k-of-G rule, and both taken out together.
  const pair = plan({
    equipment: [item('AFWA'), item('AFWB')],
    jobs: [tag('A-TAG', ['AFWA']), testJob('A-TEST', ['AFWA']), tag('B-TAG', ['AFWB']), testJob('B-TEST', ['AFWB'])],
    rules: [keepOne('K', ['AFWA', 'AFWB'])],
  })
  test('both AFW trains out together under a keep-in-service rule', () => {
    // A out 06:00Z-08:00Z (tag 06-07, test 07-08); B out 06:30Z-08:30Z. Both out 06:30Z-08:00Z.
    const result = checkPlan(pair, noVariant, [opsRow('A-TAG', '2026-11-16T06:00:00Z'), opsRow('A-TEST', '2026-11-16T07:00:00Z'), opsRow('B-TAG', '2026-11-16T06:30:00Z'), opsRow('B-TEST', '2026-11-16T07:30:00Z')])
    expect(result.feasible).toBe(false)
    const found = result.violations.find(violation => violation.code === 'keep-in-service')
    expect(found?.at).toBe('2026-11-16T06:30:00.000Z')
    expect(found?.words).toContain('Mon 16 Nov 07:30 to Mon 16 Nov 09:00')   // local times of 06:30Z and 08:00Z
  })
  test('the same pair one after the other passes', () => {
    // A out 06:00Z-08:00Z; B tagged at 08:00Z, out 08:00Z-10:00Z: never both out.
    const result = checkPlan(pair, noVariant, [opsRow('A-TAG', '2026-11-16T06:00:00Z'), opsRow('A-TEST', '2026-11-16T07:00:00Z'), opsRow('B-TAG', '2026-11-16T08:00:00Z'), opsRow('B-TEST', '2026-11-16T09:00:00Z')])
    expect(result.violations).toEqual([])
    // unavailable hours: 2 + 2
    expect(result.metrics.find(metric => metric.id === 'unavailable-hours')?.value).toBe(4)
  })

  test('a test before its tag-out, with no work between', () => {
    const lone = plan({ equipment: [item('X')], jobs: [tag('X-TAG', ['X']), testJob('X-TEST', ['X'])] })
    const result = checkPlan(lone, noVariant, [opsRow('X-TAG', '2026-11-16T08:00:00Z'), opsRow('X-TEST', '2026-11-16T06:00:00Z')])
    expect(codes(result)).toContain('tag-before-test')
    expect(codes(result)).toContain('never-returned')
  })

  test('1 of {RHR A, RHR B} with work on CCW B and RHR A: RHR B is out through its support', () => {
    const inputs = (supports: boolean) => plan({
      equipment: [item('CCWA'), item('CCWB'), item('RHRA', supports ? ['CCWA'] : []), item('RHRB', supports ? ['CCWB'] : [])],
      jobs: [tag('CCWB-TAG', ['CCWB']), testJob('CCWB-TEST', ['CCWB']), tag('RHRA-TAG', ['RHRA']), testJob('RHRA-TEST', ['RHRA'])],
      rules: [keepOne('K', ['RHRA', 'RHRB'])],
    })
    // CCW B out 06:00Z-08:00Z, so RHR B too; RHR A out 06:00Z-08:00Z. No RHR train for two hours.
    const rows = [opsRow('CCWB-TAG', '2026-11-16T06:00:00Z'), opsRow('CCWB-TEST', '2026-11-16T07:00:00Z'), opsRow('RHRA-TAG', '2026-11-16T06:00:00Z'), opsRow('RHRA-TEST', '2026-11-16T07:00:00Z')]
    const caught = checkPlan(inputs(true), noVariant, rows)
    expect(codes(caught)).toEqual(['keep-in-service'])
    expect(caught.outages.get('RHRB')).toEqual([{ from: Date.parse('2026-11-16T06:00:00Z'), to: Date.parse('2026-11-16T08:00:00Z') }])
    // Without the support, RHR B has no job and stays in service: the rule alone cannot see the loss.
    expect(checkPlan(inputs(false), noVariant, rows).violations).toEqual([])
  })

  describe('removing coverage', () => {
    const bracketed = plan({ equipment: [item('X')], jobs: [tag('X-TAG', ['X']), work('X-WORK', 'X', 2), testJob('X-TEST', ['X'])] })
    // tag 06:00Z-07:00Z; work 07:00Z-09:00Z on the day shift (local 08:00-10:00); test 09:00Z-10:00Z
    const good = [opsRow('X-TAG', '2026-11-16T06:00:00Z'), row('X-WORK', '2026-11-16T07:00:00Z', '2026-11-16T09:00:00Z', [{ resource: 'fitter', from: '2026-11-16T07:00:00Z', to: '2026-11-16T09:00:00Z' }]), opsRow('X-TEST', '2026-11-16T09:00:00Z')]
    test('the covered plan passes', () => {
      const result = checkPlan(bracketed, noVariant, good)
      expect(result.violations).toEqual([])
    })
    test('a dropped use is invisible load and is refused', () => {
      const dropped = good.map(entry => entry.job === 'X-WORK' ? { ...entry, uses: [] } : entry)
      expect(codes(checkPlan(bracketed, noVariant, dropped))).toContain('need-not-served')
      const half = good.map(entry => entry.job === 'X-WORK' ? { ...entry, uses: [{ resource: 'fitter', from: '2026-11-16T07:00:00Z', to: '2026-11-16T08:00:00Z' }] } : entry)
      expect(codes(checkPlan(bracketed, noVariant, half))).toContain('need-not-served')
    })
    test('an extra use outside the worked time is refused', () => {
      const extra = good.map(entry => entry.job === 'X-WORK' ? { ...entry, uses: [...entry.uses, { resource: 'fitter', from: '2026-11-16T09:00:00Z', to: '2026-11-16T09:30:00Z' }] } : entry)
      expect(codes(checkPlan(bracketed, noVariant, extra))).toContain('use-outside-work')
    })
    test('a tag-out that no longer covers the worked item', () => {
      const narrowed = plan({ equipment: [item('X'), item('Y')], jobs: [tag('X-TAG', ['Y']), work('X-WORK', 'X', 2), testJob('X-TEST', ['X'])] })
      expect(codes(checkPlan(narrowed, noVariant, good))).toContain('bracket-missing')
    })
    test('a test that no longer restores an item that was tagged out', () => {
      const narrowed = plan({ equipment: [item('X'), item('Y')], jobs: [tag('X-TAG', ['X', 'Y']), work('X-WORK', 'X', 2), testJob('X-TEST', ['X'])] })
      expect(codes(checkPlan(narrowed, noVariant, good))).toContain('never-returned')
    })
    test('work before its tag-out has finished', () => {
      const early = good.map(entry => entry.job === 'X-TAG' ? opsRow('X-TAG', '2026-11-16T06:30:00Z') : entry)
      expect(codes(checkPlan(bracketed, noVariant, early))).toContain('bracket')
    })
  })
})

describe('a stored proof is reused only on an exact match', () => {
  const inputs = plan({ equipment: [item('X')], jobs: [tag('X-TAG', ['X']), testJob('X-TEST', ['X'])] })
  const rows = [opsRow('X-TAG', '2026-11-16T06:00:00Z'), opsRow('X-TEST', '2026-11-16T07:00:00Z')].map(entry => ({ ...entry, float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } } }))
  const run = { grid: '30min' as const, engine: 'double', formulation: 'f-1', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
  const stored = (revision: number, inputsRevision: number) => planSchema.parse({
    id: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-0000000000aa', revision, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
    inputs,
    options: { at: '2026-11-11T00:00:00Z', by: { kind: 'agent' }, options: [{ key: 'o1', label: 'Option', variant: { methods: [], purchases: [] }, status: { word: 'validated feasible', goals: [], run }, rows, metrics: [], inputsRevision }] },
    baselines: [], changes: [], droppedChanges: 0,
  })
  test('same revision and formulation, re-checked clean: usable and may be baselined', () => {
    const plan = stored(3, 3)
    const result = recheckOption(plan, plan.options!.options[0]!, 'f-1')
    expect(result).toMatchObject({ usable: true, baselineAllowed: true, reasons: [] })
  })
  test('inputs changed since the option was computed', () => {
    const plan = stored(4, 3)
    expect(recheckOption(plan, plan.options!.options[0]!, 'f-1')).toMatchObject({ usable: false, baselineAllowed: false, reasons: ['inputs-changed'] })
  })
  test('the formulation (compiler, bounds, engine, grid, time-zone data) changed', () => {
    const plan = stored(3, 3)
    expect(recheckOption(plan, plan.options!.options[0]!, 'f-2')).toMatchObject({ usable: false, reasons: ['formulation-changed'] })
  })
  test('a "validated feasible" option that breaks a rule today is never usable', () => {
    const plan = stored(3, 3)
    const broken = { ...plan, inputs: { ...plan.inputs, rules: [{ kind: 'protected' as const, key: 'P', equipment: ['X'], words: 'X is protected', source: planner }] } }
    expect(recheckOption(broken, plan.options!.options[0]!, 'f-1')).toMatchObject({ usable: false, baselineAllowed: false, reasons: ['violations'] })
  })
})

describe('purchases', () => {
  // Nights Mon 16 and Tue 17, 19:00-07:00 local = 18:00Z-06:00Z.
  const nights = [{ start: '2026-11-16T18:00:00Z', end: '2026-11-17T06:00:00Z' }, { start: '2026-11-17T18:00:00Z', end: '2026-11-18T06:00:00Z' }]
  const withNights = (extra: Partial<PlanInputs['purchases'][number]>) => plan({
    resources: [
      { key: 'ops', label: 'Operators', kind: 'crew', count: 2, calendar: 'always', attributes: [], source: planner },
      { key: 'fitter', label: 'Fitters', kind: 'crew', count: 1, crewSize: 3, calendar: 'day', attributes: [], source: planner },
      { key: 'night-crew', label: 'Night crew', kind: 'crew', count: 1, crewSize: 3, calendar: 'none', attributes: [], source: planner },
    ],
    purchases: [{ key: 'nights', label: 'Night crew nights', resource: 'night-crew', adds: { periods: nights }, replaces: [], price: { perPeriodUsed: 1_000, once: 500 }, allowed: true, ...extra }],
    jobs: [{ key: 'N', title: 'Night job', kind: 'work', equipment: [], isolation: 'none', duration: hours(2), durationWith: [], needs: [{ anyOf: ['night-crew'], amount: 1, handover: false }], continuous: false, checks: [], tags: [] }],
    goals: [{ metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } }],
  })
  const nightRow = row('N', '2026-11-16T18:00:00Z', '2026-11-16T20:00:00Z', [{ resource: 'night-crew', from: '2026-11-16T18:00:00Z', to: '2026-11-16T20:00:00Z', purchase: 'nights' }])
  const allowed: CheckVariant = { methods: [], purchases: ['nights'] }
  test('a used night costs its period plus the mobilisation once', () => {
    const result = checkPlan(withNights({}), allowed, [nightRow])
    expect(result.violations).toEqual([])
    expect(result.goals).toEqual([{ metric: 'extra-cost', value: 1_000 + 500, unit: 'NOK' }])
  })
  test('an ordered purchase is charged whether used or not', () => {
    const ordered = withNights({ ordered: { at: '2026-11-12T09:00:00Z', by: { kind: 'human', name: 'Planner' } } })
    // the job moved to the day crew would not use the night; build the plan with no night job at all
    const empty = { ...ordered, jobs: [] }
    const result = checkPlan(empty, allowed, [])
    expect(result.goals).toEqual([{ metric: 'extra-cost', value: 2 * 1_000 + 500, unit: 'NOK' }])
  })
  test('an unordered purchase past its order deadline is unavailable', () => {
    const lapsed = withNights({ orderBy: '2026-11-10T11:00:00Z' })   // data date 12 Nov is later
    expect(codes(checkPlan(lapsed, allowed, [nightRow]))).toContain('purchase-past-deadline')
  })
  test('a purchase the variant does not allow is refused', () => {
    expect(codes(checkPlan(withNights({}), noVariant, [nightRow]))).toContain('purchase-not-allowed')
  })
  test('a rebooking makes the booked period unusable once used', () => {
    // ECT-like team booked Mon 16 08:00-12:00 local (07:00Z-11:00Z); the rebooking adds Tue 17 07:00Z-11:00Z.
    const booked = { start: '2026-11-16T07:00:00Z', end: '2026-11-16T11:00:00Z' }
    const inputs = plan({
      calendars: [...plan({}).calendars, { key: 'booked', label: 'Booked Monday', weekly: [], periods: [booked], except: [], source: planner }],
      resources: [{ key: 'team', label: 'Inspection team', kind: 'crew', count: 1, calendar: 'booked', attributes: [], source: planner }],
      purchases: [{ key: 'rebook', label: 'Rebook to Tuesday', resource: 'team', adds: { periods: [{ start: '2026-11-17T07:00:00Z', end: '2026-11-17T11:00:00Z' }] }, replaces: [booked], price: { once: 100 }, allowed: true }],
      jobs: ['I1', 'I2'].map(key => ({ key, title: `Inspection ${key}`, kind: 'work' as const, equipment: [], isolation: 'none' as const, duration: hours(2), durationWith: [], needs: [{ anyOf: ['team'], amount: 1, handover: false }], continuous: true, checks: [], tags: [] })),
    })
    const monday = row('I1', '2026-11-16T07:00:00Z', '2026-11-16T09:00:00Z', [{ resource: 'team', from: '2026-11-16T07:00:00Z', to: '2026-11-16T09:00:00Z' }])
    const tuesday = row('I2', '2026-11-17T07:00:00Z', '2026-11-17T09:00:00Z', [{ resource: 'team', from: '2026-11-17T07:00:00Z', to: '2026-11-17T09:00:00Z', purchase: 'rebook' }])
    const result = checkPlan(inputs, { methods: [], purchases: ['rebook'] }, [monday, tuesday])
    expect(codes(result)).toEqual(['use-outside-calendar'])
  })
})

describe('derived rules and the plain rules', () => {
  test('return in support order: the supporter is tested back first', () => {
    const inputs = plan({ equipment: [item('SW'), item('CCW', ['SW'])], jobs: [tag('SW-TAG', ['SW']), testJob('SW-TEST', ['SW']), tag('CCW-TAG', ['CCW']), testJob('CCW-TEST', ['CCW'])] })
    // SW out 06:00Z-09:00Z (test 08-09); CCW tested 07:00Z-08:00Z, while SW is still out.
    const rows = [opsRow('SW-TAG', '2026-11-16T06:00:00Z'), opsRow('SW-TEST', '2026-11-16T08:00:00Z'), opsRow('CCW-TAG', '2026-11-16T06:00:00Z'), opsRow('CCW-TEST', '2026-11-16T07:00:00Z')]
    expect(codes(checkPlan(inputs, noVariant, rows))).toEqual(['support-order'])
  })
  test('protected equipment: named by a job, or lost through its supporter', () => {
    const inputs = plan({
      equipment: [item('SWA'), item('SWB'), item('LOAD-B', ['SWA'])],
      jobs: [tag('B-TAG', ['SWB']), testJob('B-TEST', ['SWB']), tag('A-TAG', ['SWA']), testJob('A-TEST', ['SWA'])],
      rules: [{ kind: 'protected', key: 'P', equipment: ['SWB', 'LOAD-B'], words: 'Train B is never tagged, worked or tested', source: planner }],
    })
    const rows = [opsRow('B-TAG', '2026-11-16T06:00:00Z'), opsRow('B-TEST', '2026-11-16T07:00:00Z'), opsRow('A-TAG', '2026-11-16T08:00:00Z'), opsRow('A-TEST', '2026-11-16T09:00:00Z')]
    const found = codes(checkPlan(inputs, noVariant, rows))
    expect(found.filter(code => code === 'protected-equipment')).toHaveLength(2)
    expect(found).toContain('protected-unavailable')
  })
  test('a span limit with single entry runs from the first tag-out to the last test of the group', () => {
    const inputs = plan({
      equipment: [item('P', [], 'G'), item('Q', [], 'G')], groups: [{ key: 'G', label: 'Group G' }],
      jobs: [tag('P-TAG', ['P']), testJob('P-TEST', ['P']), tag('Q-TAG', ['Q']), testJob('Q-TEST', ['Q'])],
      rules: [{ kind: 'span-limit', key: 'L', group: 'G', limit: { value: 3, unit: 'h' }, singleEntry: true, words: 'Group G back within 3 h', source: planner }],
    })
    // P out 06:00Z-08:00Z, Q out 08:00Z-10:00Z: span 06:00Z-10:00Z = 4 h > 3 h.
    const rows = [opsRow('P-TAG', '2026-11-16T06:00:00Z'), opsRow('P-TEST', '2026-11-16T07:00:00Z'), opsRow('Q-TAG', '2026-11-16T08:00:00Z'), opsRow('Q-TEST', '2026-11-16T09:00:00Z')]
    const result = checkPlan(inputs, noVariant, rows)
    expect(codes(result)).toEqual(['span-limit'])
    expect(result.metrics.find(metric => metric.id === 'span:G')?.value).toBe(4)
  })
  test('one at a time: a count-1 crew booked twice', () => {
    const inputs = plan({ resources: [{ key: 'ops', label: 'Work-control operator', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner }], equipment: [item('X'), item('Y')], jobs: [tag('X-TAG', ['X']), testJob('X-TEST', ['X']), tag('Y-TAG', ['Y']), testJob('Y-TEST', ['Y'])] })
    const rows = [opsRow('X-TAG', '2026-11-16T06:00:00Z'), opsRow('X-TEST', '2026-11-16T07:00:00Z'), opsRow('Y-TAG', '2026-11-16T06:30:00Z'), opsRow('Y-TEST', '2026-11-16T08:00:00Z')]
    expect(codes(checkPlan(inputs, noVariant, rows))).toEqual(['over-capacity'])
  })
  test('working time pauses outside the crew calendar; a continuous job may not', () => {
    // 4 h of fitter work from Mon 13:00 local (12:00Z): Mon 13:00-15:00, then Tue 07:00-09:00 local = 06:00Z-08:00Z.
    const split = row('W', '2026-11-16T12:00:00Z', '2026-11-17T08:00:00Z', [{ resource: 'fitter', from: '2026-11-16T12:00:00Z', to: '2026-11-16T14:00:00Z' }, { resource: 'fitter', from: '2026-11-17T06:00:00Z', to: '2026-11-17T08:00:00Z' }])
    const job = { ...work('W', 'X', 4), isolation: 'none' as const, equipment: [] }
    expect(checkPlan(plan({ jobs: [job] }), noVariant, [split]).violations).toEqual([])
    expect(codes(checkPlan(plan({ jobs: [{ ...job, continuous: true }] }), noVariant, [split]))).toContain('not-continuous')
    const late = { ...split, finish: '2026-11-17T08:30:00Z' }
    expect(codes(checkPlan(plan({ jobs: [job] }), noVariant, [late]))).toContain('finish-mismatch')
  })
  test('links keep their clock-time lags: start-to-start 2 h and finish-to-finish 1 h', () => {
    const a = { ...work('A', 'X', 4), isolation: 'none' as const, equipment: [], needs: ops(), continuous: true }
    const b = { ...a, key: 'B', title: 'B' }
    const inputs = plan({ jobs: [a, b], links: [{ from: 'A', to: 'B', type: 'SS', lag: { value: 2, unit: 'h' } }, { from: 'A', to: 'B', type: 'FF', lag: { value: 1, unit: 'h' } }] })
    const rowOf = (key: string, start: string, finish: string) => row(key, start, finish, [{ resource: 'ops', from: start, to: finish }])
    // A 06:00Z-10:00Z. B at 08:00Z-12:00Z: SS gap 2 h, FF gap 2 h. B at 07:00Z: SS gap 1 h, too early.
    expect(checkPlan(inputs, noVariant, [rowOf('A', '2026-11-16T06:00:00Z', '2026-11-16T10:00:00Z'), rowOf('B', '2026-11-16T08:00:00Z', '2026-11-16T12:00:00Z')]).violations).toEqual([])
    expect(codes(checkPlan(inputs, noVariant, [rowOf('A', '2026-11-16T06:00:00Z', '2026-11-16T10:00:00Z'), rowOf('B', '2026-11-16T07:00:00Z', '2026-11-16T11:00:00Z')]))).toEqual(['link'])
  })
  test('releases, locks, the window and scheduling every job exactly once', () => {
    const job = { ...tag('T', ['X']), kind: 'work' as const, equipment: [], notBefore: { at: '2026-11-16T08:00:00Z', words: 'Parts arrive', source: { by: 'assumption' as const } }, lock: { start: '2026-11-16T09:00:00Z' } }
    const other = { ...tag('U', ['X']), kind: 'work' as const, equipment: [] }
    const inputs = plan({ jobs: [job, other] })
    expect(codes(checkPlan(inputs, noVariant, [opsRow('T', '2026-11-16T07:00:00Z')]))).toEqual(['lock', 'not-scheduled', 'release'])
    expect(codes(checkPlan(inputs, noVariant, [opsRow('T', '2026-11-16T09:00:00Z'), opsRow('U', '2026-11-18T06:00:00Z')]))).toContain('outside-window')
    expect(codes(checkPlan(inputs, noVariant, [opsRow('T', '2026-11-16T09:00:00Z'), opsRow('U', '2026-11-16T06:00:00Z'), opsRow('U', '2026-11-16T07:00:00Z')]))).toContain('scheduled-twice')
  })
  test('a due rule is hard; a job target is soft and only counts as lateness', () => {
    const late = { ...tag('T', ['X']), kind: 'work' as const, equipment: [], target: { finishBy: '2026-11-16T07:00:00Z', words: 'Hoped for by 08:00' } }
    const due = { kind: 'due' as const, key: 'D', job: 'T', finishBy: '2026-11-16T07:30:00Z', words: 'Surveillance due Mon 08:30', source: planner }
    // T runs 07:00Z-08:00Z: 1 h past its target, 0.5 h past its due time (08:30 local = 07:30Z)
    const rows = [opsRow('T', '2026-11-16T07:00:00Z')]
    const soft = checkPlan(plan({ jobs: [late] }), noVariant, rows)
    expect(soft.violations).toEqual([])
    expect(soft.metrics.find(metric => metric.id === 'lateness')?.value).toBe(1)
    const hard = checkPlan(plan({ jobs: [late], rules: [due] }), noVariant, rows)
    expect(codes(hard)).toEqual(['due'])
    expect(hard.violations[0]?.words).toContain('Mon 16 Nov 09:00, 0.5 h after it is due at Mon 16 Nov 08:30')
  })
  test('a precondition is checked against the World values at read time', () => {
    const locator = 'process-plant/plant%3Ax/pumpB'
    const guarded = { ...tag('A-TAG', ['A']), checks: [{ equipment: 'B', fact: 'pumpB/running', expect: true, words: 'B running' }] }
    const inputs = (value?: boolean) => plan({
      equipment: [item('A'), { ...item('B'), locator }], jobs: [guarded, testJob('A-TEST', ['A'])],
      world: { refreshedAt: '2026-11-12T09:00:00Z', facts: value === undefined ? [] : [{ locator, id: 'pumpB/running', label: 'Running', quantity: 'state', value, basis: 'observed', at: '2026-11-12T09:00:00Z' }] },
    })
    const rows = [opsRow('A-TAG', '2026-11-16T06:00:00Z'), opsRow('A-TEST', '2026-11-16T07:00:00Z')]
    expect(codes(checkPlan(inputs(), noVariant, rows))).toEqual(['precondition-unread'])
    expect(codes(checkPlan(inputs(false), noVariant, rows))).toEqual(['precondition-unmet'])
    expect(checkPlan(inputs(true), noVariant, rows).violations).toEqual([])
  })
  test('a test estimated below its declared minimum', () => {
    const short = { ...testJob('X-TEST', ['X']), minimum: { value: 1.5, unit: 'h' as const, words: 'Pump run of 90 minutes' } }
    const inputs = plan({ equipment: [item('X')], jobs: [tag('X-TAG', ['X']), short] })
    expect(codes(checkPlan(inputs, noVariant, [opsRow('X-TAG', '2026-11-16T06:00:00Z'), opsRow('X-TEST', '2026-11-16T07:00:00Z')]))).toEqual(['below-minimum'])
  })
  test('a method option the variant does not choose is not scheduled', () => {
    const inputs = plan({
      methods: [{ key: 'M', label: 'Method', options: [{ key: 'a', label: 'A', fixedCost: 10 }, { key: 'b', label: 'B', fixedCost: 20 }] }],
      jobs: [{ ...tag('JA', ['X']), kind: 'work', equipment: [], method: { choice: 'M', option: 'a' } }, { ...tag('JB', ['X']), kind: 'work', equipment: [], method: { choice: 'M', option: 'b' } }],
      goals: [{ metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } }],
    })
    const variant = { methods: [{ choice: 'M', option: 'a' }], purchases: [] }
    const result = checkPlan(inputs, variant, [opsRow('JA', '2026-11-16T06:00:00Z')])
    expect(result.violations).toEqual([])
    expect(result.goals).toEqual([{ metric: 'extra-cost', value: 10, unit: 'NOK' }])
    expect(codes(checkPlan(inputs, variant, [opsRow('JA', '2026-11-16T06:00:00Z'), opsRow('JB', '2026-11-16T06:00:00Z')]))).toEqual(['not-in-variant'])
    expect(codes(checkPlan(inputs, noVariant, []))).toContain('method-choice')
  })
})

describe('resource rules: requirement at the start, jobs ahead, coverage of resources', () => {
  // 30 s grid, 08:00Z-08:30Z. A truck's payload is 300 kg until 08:03Z, then 600 kg.
  const facts = (seconds: number) => [{ locator: 'pack/unit-1', id: 'unit-1/run-seconds', label: 'Run', quantity: 'time', unit: 's', value: seconds, basis: 'owner-estimate' as const, at: '2026-09-03T08:00:00Z' }]
  const inputs = (fields: Partial<PlanInputs> = {}) => plan({
    settings: { title: 'Trucks', timeZone: 'Europe/Oslo', window: { start: '2026-09-03T08:00:00Z', end: '2026-09-03T08:30:00Z' }, dataDate: '2026-09-03T08:00:00Z', grid: '30s', currency: 'NOK', run: null },
    calendars: [{ key: 'duty', label: 'On duty', weekly: [], periods: [{ start: '2026-09-03T08:00:00Z', end: '2026-09-03T08:30:00Z' }], except: [], source: planner }],
    resources: [
      { key: 'truck-1', label: 'Truck 1', kind: 'tool', count: 1, calendar: 'duty', maxJobs: 1, attributes: [{ key: 'payload', label: 'Payload', value: 300, unit: 'kg', changes: [{ at: '2026-09-03T08:03:00Z', value: 600 }], origin: planner }], source: planner },
      { key: 'truck-2', label: 'Truck 2', kind: 'tool', count: 1, calendar: 'duty', maxJobs: 1, attributes: [{ key: 'payload', label: 'Payload', value: 1_000, unit: 'kg', changes: [], origin: planner }], source: planner },
    ],
    jobs: ['R1', 'R2'].map(key => ({
      key, title: `Serve ${key}`, kind: 'work' as const, equipment: [], isolation: 'none' as const,
      duration: { value: null, unit: 's' as const, calendar: 'elapsed' as const, origin: { by: 'world' as const, refs: [{ locator: 'pack/unit-1', fact: 'unit-1/run-seconds' }] } },
      durationWith: [], needs: [{ anyOf: ['truck-1', 'truck-2'], amount: 1, where: { attribute: 'payload', atLeast: 500, unit: 'kg' }, handover: false }], continuous: true, checks: [], tags: [],
    })),
    goals: [{ metric: 'lateness', tolerance: { value: 0, unit: 'min' } }],
    world: { refreshedAt: '2026-09-03T08:00:00Z', facts: facts(150) },
    ...fields,
  })
  const truckRow = (job: string, truck: string, start: string) => {
    const finish = new Date(Date.parse(start) + 150_000).toISOString().replace('.000Z', 'Z')   // 150 s = 5 slots of 30 s
    return row(job, start, finish, [{ resource: truck, from: start, to: finish }])
  }
  test('the requirement is judged with the value in force at the start', () => {
    expect(codes(checkPlan(inputs(), noVariant, [truckRow('R1', 'truck-1', '2026-09-03T08:02:30Z'), truckRow('R2', 'truck-2', '2026-09-03T08:00:00Z')]))).toEqual(['where-not-met'])
    expect(checkPlan(inputs(), noVariant, [truckRow('R1', 'truck-1', '2026-09-03T08:03:00Z'), truckRow('R2', 'truck-2', '2026-09-03T08:00:00Z')]).violations).toEqual([])
  })
  test('a World duration that is not read leaves the job without a duration', () => {
    expect(codes(checkPlan(inputs({ world: { refreshedAt: null, facts: [] } }), noVariant, [truckRow('R1', 'truck-1', '2026-09-03T08:03:00Z'), truckRow('R2', 'truck-2', '2026-09-03T08:00:00Z')]))).toEqual(['world-value-unread', 'world-value-unread'])
  })
  test('at most this many jobs ahead for a resource', () => {
    // both jobs on truck 2, one after the other: capacity holds, the jobs-ahead limit does not
    expect(codes(checkPlan(inputs(), noVariant, [truckRow('R1', 'truck-2', '2026-09-03T08:00:00Z'), truckRow('R2', 'truck-2', '2026-09-03T08:03:00Z')]))).toEqual(['max-jobs'])
  })
  test('keeping a resource free: a busy truck does not count as in service', () => {
    const rule = { kind: 'keep-in-service' as const, key: 'free', members: [{ resource: 'truck-1' }, { resource: 'truck-2' }], atLeast: 1, words: 'Keep one truck free', source: planner }
    // 08:03:00Z-08:05:30Z both trucks busy
    const result = checkPlan(inputs({ rules: [rule] }), noVariant, [truckRow('R1', 'truck-1', '2026-09-03T08:03:00Z'), truckRow('R2', 'truck-2', '2026-09-03T08:03:00Z')])
    expect(codes(result)).toEqual(['keep-in-service'])
    expect(result.violations[0]?.at).toBe('2026-09-03T08:03:00.000Z')
  })
})

describe('certificates are re-verified from the inputs', () => {
  // A chain of three day-shift jobs, 4 + 8 + 6 = 18 h, in a window with 2 day shifts (Mon, Tue 07:00-15:00 local = 16 h).
  const chain = plan({
    jobs: [['C1', 4], ['C2', 8], ['C3', 6]].map(([key, length]) => ({ ...work(String(key), 'X', Number(length)), equipment: [], isolation: 'none' as const })),
    links: [{ from: 'C1', to: 'C2', type: 'FS', lag: { value: 0, unit: 'h' } }, { from: 'C2', to: 'C3', type: 'FS', lag: { value: 0, unit: 'h' } }],
  })
  const certificate = (workHours: number, availableHours: number, jobs = ['C1', 'C2', 'C3']) => ({ kind: 'chain' as const, jobs, workHours, calendars: ['day'], availableHours, from: '2026-11-16T06:00:00Z', by: '2026-11-18T06:00:00Z' })
  test('a true chain proof is confirmed with the checker\'s own figures', () => {
    const result = verifyCertificate(chain, noVariant, certificate(18, 16))
    expect(result).toMatchObject({ proves: true, figures: { workHours: 18, availableHours: 16 } })
  })
  test('a chain that undercounts the available hours is refused', () => {
    expect(verifyCertificate(chain, noVariant, certificate(18, 12)).proves).toBe(false)
  })
  test('jobs that are not bound one after the other are not a chain', () => {
    expect(verifyCertificate(chain, noVariant, certificate(18, 16, ['C1', 'C3', 'C2'])).proves).toBe(false)
  })
})

describe('review fixes: duty, ordered purchases, second outages, progress lags, the data date, invalid input', () => {
  const ot = { key: 'ot', label: 'Overtime', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'] as Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri'>, from: '15:00', to: '19:00' }], periods: [], except: [], source: planner }
  const crews = [
    { key: 'f1', label: 'Fitter crew 1', kind: 'crew' as const, count: 1, crewSize: 3, calendar: 'day', attributes: [], source: planner },
    { key: 'f2', label: 'Fitter crew 2', kind: 'crew' as const, count: 1, crewSize: 3, calendar: 'day', attributes: [], source: planner },
  ]
  const overtime = (resource: string, ordered = false) => ({ key: `ot-${resource}`, label: `Overtime ${resource}`, resource, adds: { calendar: 'ot' }, replaces: [], price: { perPersonHour: 1_050 }, allowed: true, ...(ordered ? { ordered: { at: '2026-11-13T10:00:00Z', by: { kind: 'human' as const, name: 'Planner' } } } : {}) })
  const crewJob = (key: string, crew: string, length: number) => ({ ...work(key, 'X', length, true), equipment: [], isolation: 'none' as const, needs: [{ anyOf: [crew], amount: 1, handover: false }] })

  test('keep one crew free 16:00-19:00 local: overtime bought only 15:00-16:00 does not put a crew on duty after it', () => {
    // f1 works 14:00-16:00 local (13:00Z-15:00Z), the last hour on overtime; f2 works 13:00Z-17:00Z, overtime from 14:00Z
    const inputs = plan({
      calendars: [...plan({}).calendars, ot], resources: crews, purchases: [overtime('f1'), overtime('f2')],
      jobs: [crewJob('W1', 'f1', 2), crewJob('W2', 'f2', 4)],
      rules: [{ kind: 'keep-in-service', key: 'K', members: [{ resource: 'f1' }, { resource: 'f2' }], atLeast: 1, during: { start: '2026-11-16T15:00:00Z', end: '2026-11-16T18:00:00Z' }, words: 'Keep one fitter crew free 16-19', source: planner }],
    })
    const rows = [
      row('W1', '2026-11-16T13:00:00Z', '2026-11-16T15:00:00Z', [{ resource: 'f1', from: '2026-11-16T13:00:00Z', to: '2026-11-16T14:00:00Z' }, { resource: 'f1', from: '2026-11-16T14:00:00Z', to: '2026-11-16T15:00:00Z', purchase: 'ot-f1' }]),
      row('W2', '2026-11-16T13:00:00Z', '2026-11-16T17:00:00Z', [{ resource: 'f2', from: '2026-11-16T13:00:00Z', to: '2026-11-16T14:00:00Z' }, { resource: 'f2', from: '2026-11-16T14:00:00Z', to: '2026-11-16T17:00:00Z', purchase: 'ot-f2' }]),
    ]
    const result = checkPlan(inputs, { methods: [], purchases: ['ot-f1', 'ot-f2'] }, rows)
    expect(codes(result)).toEqual(['keep-in-service'])
    expect(result.violations[0]?.at).toBe('2026-11-16T15:00:00.000Z')
  })
  test('ordered overtime is charged for every ordered person-hour, used or not', () => {
    // Window Mon 07:00-Wed 07:00 local: overtime Mon and Tue 15:00-19:00 = 8 h, 3 persons, NOK 1,050 = 25,200
    const inputs = plan({ calendars: [...plan({}).calendars, ot], resources: crews, purchases: [overtime('f1', true)], jobs: [crewJob('W', 'f1', 2)], goals: [{ metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } }] })
    const unused = checkPlan(inputs, noVariant, [row('W', '2026-11-16T06:00:00Z', '2026-11-16T08:00:00Z', [{ resource: 'f1', from: '2026-11-16T06:00:00Z', to: '2026-11-16T08:00:00Z' }])])
    expect(unused.violations).toEqual([])
    expect(unused.goals).toEqual([{ metric: 'extra-cost', value: 8 * 3 * 1_050, unit: 'NOK' }])
    // partly used (1 h of it): the same ordered hours, and no "not allowed" though the variant omits it
    const partly = checkPlan(inputs, noVariant, [row('W', '2026-11-16T13:00:00Z', '2026-11-16T15:00:00Z', [{ resource: 'f1', from: '2026-11-16T13:00:00Z', to: '2026-11-16T14:00:00Z' }, { resource: 'f1', from: '2026-11-16T14:00:00Z', to: '2026-11-16T15:00:00Z', purchase: 'ot-f1' }])])
    expect(partly.violations).toEqual([])
    expect(partly.goals).toEqual([{ metric: 'extra-cost', value: 8 * 3 * 1_050, unit: 'NOK' }])
  })
  test('a planned second outage (tag, test, tag, test) is two outages, each measured', () => {
    const twice = plan({ equipment: [item('X')], jobs: [tag('T1', ['X']), testJob('R1', ['X']), tag('T2', ['X']), work('W2', 'X', 1), testJob('R2', ['X'])] })
    // out 06:00Z-08:00Z, then 09:00Z-12:00Z with fitter work 10:00Z-11:00Z (day shift) in the second outage
    const rows = [opsRow('T1', '2026-11-16T06:00:00Z'), opsRow('R1', '2026-11-16T07:00:00Z'), opsRow('T2', '2026-11-16T09:00:00Z'),
      row('W2', '2026-11-16T10:00:00Z', '2026-11-16T11:00:00Z', [{ resource: 'fitter', from: '2026-11-16T10:00:00Z', to: '2026-11-16T11:00:00Z' }]), opsRow('R2', '2026-11-16T11:00:00Z')]
    const result = checkPlan(twice, noVariant, rows)
    expect(result.violations).toEqual([])
    expect(result.metrics.find(metric => metric.id === 'unavailable-hours')?.value).toBe(2 + 3)
    // under a single-entry limit of 4 h, the words say it was out twice and the span counts from the first tag
    const limited = plan({ ...twice, equipment: [item('X', [], 'G')], groups: [{ key: 'G', label: 'Group G' }], rules: [{ kind: 'span-limit', key: 'L', group: 'G', limit: { value: 4, unit: 'h' }, singleEntry: true, words: 'G back within 4 h', source: planner }] })
    const refused = checkPlan(limited, noVariant, rows)
    expect(codes(refused)).toEqual(['span-limit'])
    expect(refused.violations[0]?.words).toContain('It is out 2 times (back at Mon 16 Nov 09:00, out again at Mon 16 Nov 10:00)')
  })
  test('start-to-start counts the predecessor\'s work done: 1 h of opening is not 2 h', () => {
    // OPEN: 4 h fitter work from Mon 14:00 local (13:00Z): Mon 13:00Z-14:00Z, Tue 06:00Z-09:00Z. CLEAN starts Mon 15:00Z.
    const open = { ...work('OPEN', 'X', 4), equipment: [], isolation: 'none' as const, title: 'Open heads' }
    const clean = { ...tag('CLEAN', ['X']), kind: 'work' as const, equipment: [], title: 'Clean tubes', duration: hours(19) }
    const inputs = plan({ jobs: [open, clean], links: [{ from: 'OPEN', to: 'CLEAN', type: 'SS', lag: { value: 2, unit: 'h' } }, { from: 'OPEN', to: 'CLEAN', type: 'FF', lag: { value: 1, unit: 'h' } }] })
    const openRow = row('OPEN', '2026-11-16T13:00:00Z', '2026-11-17T09:00:00Z', [{ resource: 'fitter', from: '2026-11-16T13:00:00Z', to: '2026-11-16T14:00:00Z' }, { resource: 'fitter', from: '2026-11-17T06:00:00Z', to: '2026-11-17T09:00:00Z' }])
    const cleanRow = row('CLEAN', '2026-11-16T15:00:00Z', '2026-11-17T10:00:00Z', [{ resource: 'ops', from: '2026-11-16T15:00:00Z', to: '2026-11-17T10:00:00Z' }])
    const result = checkPlan(inputs, noVariant, [openRow, cleanRow])
    expect(codes(result)).toEqual(['link'])
    expect(result.violations[0]?.words).toBe("'Clean tubes' starts after only 1 h of 'Open heads'; the link needs 2 h of it done first.")
  })
  test('finish-to-finish counts the successor\'s work after: 0.5 h is not 1 h', () => {
    // A: operators Mon 10:00Z-14:00Z. B: 4 h fitter work from 10:30Z: 10:30Z-14:00Z, then Tue 06:00Z-06:30Z.
    const a = { ...tag('A', ['X']), kind: 'work' as const, equipment: [], title: 'Drain', duration: hours(4) }
    const b = { ...work('B', 'X', 4), equipment: [], isolation: 'none' as const, title: 'Flush' }
    const inputs = plan({ jobs: [a, b], links: [{ from: 'A', to: 'B', type: 'FF', lag: { value: 1, unit: 'h' } }] })
    const rows = [row('A', '2026-11-16T10:00:00Z', '2026-11-16T14:00:00Z', [{ resource: 'ops', from: '2026-11-16T10:00:00Z', to: '2026-11-16T14:00:00Z' }]),
      row('B', '2026-11-16T10:30:00Z', '2026-11-17T06:30:00Z', [{ resource: 'fitter', from: '2026-11-16T10:30:00Z', to: '2026-11-16T14:00:00Z' }, { resource: 'fitter', from: '2026-11-17T06:00:00Z', to: '2026-11-17T06:30:00Z' }])]
    const result = checkPlan(inputs, noVariant, rows)
    expect(codes(result)).toEqual(['link'])
    expect(result.violations[0]?.words).toBe("Only 0.5 h of 'Flush' is done after 'Drain' finishes; the link needs 1 h of it after.")
  })
  test('nothing is planned before the data date', () => {
    const inputs = plan({ settings: { ...plan({}).settings, dataDate: '2026-11-16T12:00:00Z' }, jobs: [{ ...tag('A', ['X']), kind: 'work' as const, equipment: [] }] })
    const result = checkPlan(inputs, noVariant, [opsRow('A', '2026-11-16T06:00:00Z')])
    expect(codes(result)).toEqual(['before-data-date'])
    expect(result.violations[0]?.words).toContain('before the data date Mon 16 Nov 13:00')
    expect(checkPlan(inputs, noVariant, [opsRow('A', '2026-11-16T12:00:00Z')]).violations).toEqual([])
  })
  test('a working-time job with no needs is invalid input, not infeasible', () => {
    const inputs = plan({ jobs: [{ ...tag('A', ['X']), kind: 'work' as const, equipment: [], needs: [] }] })
    const result = checkPlan(inputs, noVariant, [row('A', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z', [])])
    expect(codes(result)).toEqual(['no-working-calendar'])
    expect(result.invalidInput).toBe(true)
    expect(checkPlan(plan({}), noVariant, []).invalidInput).toBe(false)
  })
})

describe('waivers, for counterfactual harnesses only', () => {
  test('a waived derived order is not checked; every other rule still is', () => {
    const inputs = plan({ equipment: [item('X')], jobs: [tag('X-TAG', ['X']), testJob('X-TEST', ['X'])] })
    // the test overlaps its tag-out: refused, unless that one order is waived
    const rows = [opsRow('X-TAG', '2026-11-16T06:00:00Z'), opsRow('X-TEST', '2026-11-16T06:30:00Z')]
    expect(codes(checkPlan(inputs, noVariant, rows))).toEqual(['tag-before-test'])
    expect(checkPlan(inputs, noVariant, rows, { orders: [['X-TAG', 'X-TEST']] }).violations).toEqual([])
    expect(codes(checkPlan(inputs, noVariant, rows, { orders: [['X-TEST', 'X-TAG']] }))).toEqual(['tag-before-test'])
  })
})
