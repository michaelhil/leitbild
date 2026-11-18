import { describe, expect, test } from 'bun:test'
import { planInputsSchema, statusSchema, type PlanInputs } from '../plan/schema.ts'
import fragmentJson from '../plan/fixtures/train-a.fragment.json'
import { claimsProof, feasibleStatus, goalGap, goalStatuses, redundancyWarning, showStatus, withoutProof, type CheckPlan, verifiedGoals } from './status.ts'

const inputs: PlanInputs = planInputsSchema.parse(fragmentJson)
const run = { grid: '30min' as const, engine: 'lahc-1', formulation: 'F1', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'cpu' as const, evals: 1, cpuMs: 1 }
const goals = inputs.goals   // span over 54 h, extra cost (step NOK 25,000), unavailable hours
const clean: CheckPlan = () => ({ violations: [], goals: [] })
const proves = () => ({ proves: true })

describe('status words', () => {
  test('optimal at the goal resolution: half a 30 min slot of MILP noise still equals', () => {
    const { goals: words } = goalStatuses(goals, '30min', [[54.2], 464_250, 230], [{ value: [54], source: 'logic+calendars' }, { value: 425_050, source: 'fixed-costs' }, { value: 100, source: 'logic+calendars' }])
    // span 54.2 h is 0.2 h over; the bound 54 h is 0 over: |0.2 - 0| < 0.25 h, so proven.
    expect(words[0]!.word).toBe('proven optimal')
    expect(words[1]!.word).toBe('best found under budget')
    expect(goalGap(words[1]!)).toBe(464_250 - 425_050)
    expect(words[2]!.word).toBe('best found under budget')
  })

  test('a later goal is never optimal while an earlier one is unproven', () => {
    const { goals: words } = goalStatuses(goals, '30min', [[57], 425_050, 100], [{ value: [55], source: 'logic+calendars' }, { value: 425_050, source: 'fixed-costs' }, { value: 100, source: 'logic+calendars' }])
    expect(words.map(word => word.word)).toEqual(['best found under budget', 'best found under budget', 'best found under budget'])
    // The gap is in the goal's unit: 3 h over against 1 h over is 2 h.
    expect(goalGap(words[0]!)).toBe(2)
  })

  test('a bound above the value is not shown and is reported', () => {
    const { goals: words, conflicts } = goalStatuses(goals, '30min', [[50], 400_000, 100], [{ value: [50], source: 'logic+calendars' }, { value: 500_000, source: 'fixed-costs' }, { value: 0, source: 'logic+calendars' }])
    expect(conflicts).toEqual([1])
    expect(words[1]!.bound).toBeUndefined()
    expect(statusSchema.safeParse({ word: 'validated feasible', goals: words, run }).success).toBe(true)
  })

  test('removing proof words leaves a status the schema accepts', () => {
    const { status } = feasibleStatus(goals, run, [[50], 425_050, 100], [{ value: [40], source: 'logic+calendars' }, { value: 425_050, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'swap', amount: 425_050 }] } }, { value: 100, source: 'logic+calendars', certificate: { kind: 'least-outage', items: [{ item: 'SWA', from: '2026-11-16T06:00:00Z', to: '2026-11-20T10:00:00Z' }] } }])
    expect(status.word === 'validated feasible' && status.goals.map(goal => goal.word)).toEqual(['proven optimal', 'proven optimal', 'proven optimal'])
    // A proven goal without its bound's certificate is not proven: from it on, best found.
    const uncertified = feasibleStatus(goals, run, [[50], 425_050, 100], [{ value: [40], source: 'logic+calendars' }, { value: 425_050, source: 'fixed-costs' }, { value: 100, source: 'logic+calendars' }]).status
    expect(uncertified.word === 'validated feasible' && uncertified.goals.map(goal => goal.word)).toEqual(['proven optimal', 'best found under budget', 'best found under budget'])
    // Lane K re-derives each claim: the first it does not prove, and every later goal, read best found.
    const second = verifiedGoals(status, goal => ({ proves: goal !== 1 }))
    expect(second.word === 'validated feasible' && second.goals.map(goal => [goal.word, goal.bound !== undefined])).toEqual([['proven optimal', true], ['best found under budget', false], ['best found under budget', true]])
    const plain = withoutProof(status)
    expect(plain.word === 'validated feasible' && plain.goals.every(goal => goal.word === 'best found under budget' && goal.bound === undefined)).toBe(true)
    expect(withoutProof({ word: 'proven infeasible', cause: { kind: 'temporal', steps: [] }, run }).word).toBe('unresolved')
  })
})

describe('every shown status is re-checked against the current inputs', () => {
  const { status } = feasibleStatus(goals, run, [[50], 425_050, 100], [{ value: [40], source: 'logic+calendars' }, { value: 425_050, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'swap', amount: 425_050 }] } }, { value: 100, source: 'logic+calendars', certificate: { kind: 'least-outage', items: [{ item: 'SWA', from: '2026-11-16T06:00:00Z', to: '2026-11-20T10:00:00Z' }] } }])
  const option = { key: 'swap', status, rows: [], inputsRevision: 3, variant: { methods: [], purchases: [] } }

  test('proof is reused only on the exact inputs revision and formulation', () => {
    expect(showStatus(option, { inputs, revision: 3, formulation: 'F1' }, clean, proves)).toEqual({ status, warnings: [] })
    const newer = showStatus(option, { inputs, revision: 4, formulation: 'F1' }, clean, proves)
    expect(newer.stale?.codes).toEqual(['inputs_changed'])
    expect(newer.status.word === 'validated feasible' && newer.status.goals.some(goal => goal.word === 'proven optimal')).toBe(false)
    expect(showStatus(option, { inputs, revision: 3, formulation: 'F2' }, clean, proves).stale?.codes).toEqual(['formulation_changed'])
  })

  test('a plan that breaks a rule on the current inputs is never shown as feasible', () => {
    const broken: CheckPlan = () => ({ violations: [{ code: 'protected_equipment', about: ['SWB'] }], goals: [] })
    const shown = showStatus(option, { inputs, revision: 3, formulation: 'F1' }, broken, proves)
    expect(shown.status.word).toBe('unresolved')
    expect(shown.stale?.codes).toEqual(['violations'])
  })

  test('an input finding on the current inputs shows "invalid input" with its cause', () => {
    const unread: CheckPlan = () => ({ violations: [{ code: 'precondition-unread', about: ['SWA-TAG', 'SWB'] }], goals: [] })
    const shown = showStatus(option, { inputs, revision: 3, formulation: 'F1' }, unread, proves)
    expect(shown.status).toEqual({ word: 'invalid input', problems: [{ about: ['SWA-TAG', 'SWB'], code: 'precondition-unread' }] })
    expect(shown.stale?.codes).toEqual(['invalid_input'])
  })

  test('a certificate that lane K rejects is not shown as proof', () => {
    const refused = { ...option, status: { word: 'proven infeasible' as const, cause: { kind: 'temporal' as const, steps: [] }, run } }
    expect(showStatus(refused, { inputs, revision: 3, formulation: 'F1' }, clean, () => ({ proves: false })).status.word).toBe('unresolved')
    expect(showStatus(refused, { inputs, revision: 3, formulation: 'F1' }, clean, proves).status.word).toBe('proven infeasible')
  })
})

describe('redundancy warning beside the status (adversary r2 item 7)', () => {
  // Two pumps of one function, both taken out on Monday, and no keep-in-service rule names either.
  const job = (key: string, kind: 'tag-out' | 'test', item: string) => ({
    key, title: key, kind, equipment: [item], isolation: 'none', duration: { value: 1, unit: 'h', calendar: 'working', origin: { by: 'planner' } },
    durationWith: [], needs: [], continuous: true, checks: [], tags: [],
  })
  const pair = planInputsSchema.parse({
    ...inputs,
    equipment: [{ key: 'MFWA', label: 'Main feed pump A', supportedBy: [] }, { key: 'MFWB', label: 'Main feed pump B', supportedBy: [] }],
    groups: [], rules: [], jobs: [job('A-TAG', 'tag-out', 'MFWA'), job('A-RTS', 'test', 'MFWA'), job('B-TAG', 'tag-out', 'MFWB'), job('B-RTS', 'test', 'MFWB')], links: [],
    goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }],
  })
  const row = (key: string, start: string, finish: string) => ({ job: key, start, finish, uses: [], float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } } })
  const rows = [row('A-TAG', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), row('A-RTS', '2026-11-16T10:00:00Z', '2026-11-16T11:00:00Z'), row('B-TAG', '2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z'), row('B-RTS', '2026-11-16T12:00:00Z', '2026-11-16T13:00:00Z')]

  // Lane A's equipment `function` key: both feed pumps back each other up.
  const withFunction = (inputs: PlanInputs, key: string): PlanInputs => planInputsSchema.parse({ ...inputs, equipment: inputs.equipment.map(item => ({ ...item, function: key })) })
  const paired = withFunction(pair, 'main-feedwater')

  test('without a function key nothing warns: items out together are not assumed to back each other up', () => {
    expect(redundancyWarning(pair, rows)).toBeUndefined()
  })

  test('two items of one function out together with no rule: warned, from B tagged (08:00Z) to A back (11:00Z)', () => {
    const pair = paired
    expect(redundancyWarning(pair, rows)).toEqual({ code: 'redundancy_unruled', items: ['MFWA', 'MFWB'], from: '2026-11-16T08:00:00.000Z', to: '2026-11-16T11:00:00.000Z' })
    const shown = showStatus({ key: 'o', status: feasibleStatus(pair.goals, run, [10], undefined).status, rows, inputsRevision: 1, variant: { methods: [], purchases: [] } }, { inputs: pair, revision: 1, formulation: 'F1' }, clean, proves)
    expect(shown.status.word).toBe('validated feasible')
    expect(shown.warnings.map(warning => warning.code)).toEqual(['redundancy_unruled'])
  })

  test('a keep-in-service rule naming them removes the warning', () => {
    const ruled = withFunction(planInputsSchema.parse({ ...pair, rules: [{ kind: 'keep-in-service', key: 'K', members: [{ equipment: 'MFWA' }, { equipment: 'MFWB' }], atLeast: 1, words: 'One feed pump in service.', source: { by: 'planner' } }] }), 'main-feedwater')
    expect(redundancyWarning(ruled, rows)).toBeUndefined()
  })
})

describe('a what-if\'s lead in the proof helpers (adversary part 2 check, fixes B and C)', () => {
  const span = (value: number) => ({ value, source: 'logic+calendars' as const, certificate: { kind: 'least-span' as const, spans: [{ group: 'AFW-A', hours: value }] } })
  const cost = { value: 425_050, source: 'fixed-costs' as const, certificate: { kind: 'fixed-costs' as const, items: [{ key: 'swap', amount: 425_050 }] } }
  const found = (goal: number, value: number, unit: string) => ({ word: 'best found under budget' as const, goal, value, unit })
  // "Finish AFW A first": the group's own line leads, proven at its least span; no plan goal is proven.
  const groupLed = statusSchema.parse({ word: 'validated feasible', run, goals: [found(0, 2, 'h'), found(1, 464_250, 'NOK'), found(2, 230, 'h')], lead: { word: 'proven optimal', group: 'AFW-A', value: 20, unit: 'h', bound: span(20) } })
  // "Cheapest that keeps every rule": the plan's goal 1 leads and is proven; goal 0 before it is not.
  const costLed = statusSchema.parse({ word: 'validated feasible', run, goals: [found(0, 2, 'h'), { word: 'proven optimal', goal: 1, value: 425_050, unit: 'NOK', bound: cost }, found(2, 230, 'h')], lead: { goal: 1 } })

  test('B: an out-of-date group what-if reads "best found", its bound dropped', () => {
    const plain = withoutProof(groupLed)
    expect(plain.word === 'validated feasible' && plain.lead).toEqual({ word: 'best found under budget', group: 'AFW-A', value: 20, unit: 'h' })
    const shown = showStatus({ key: 'afw-first', status: groupLed, rows: [], inputsRevision: 3, variant: { methods: [], purchases: [] } }, { inputs, revision: 4, formulation: 'F1' }, clean, proves)
    expect(shown.status.word === 'validated feasible' && shown.status.lead !== undefined && 'word' in shown.status.lead ? shown.status.lead.word : undefined).toBe('best found under budget')
  })

  test('B: a group lead\'s proof is a proof claim; a goal lead\'s too', () => {
    expect(claimsProof(groupLed)).toBe(true)
    expect(claimsProof(withoutProof(groupLed))).toBe(false)
    expect(claimsProof(costLed)).toBe(true)
  })

  test('C: verifiedGoals keeps a valid proof on lead {goal: 1}, with goal 0 not proven before it', () => {
    const asked: number[] = []
    const kept = verifiedGoals(costLed, goal => { asked.push(goal); return { proves: true } })
    expect(kept).toEqual(costLed)
    expect(asked).toEqual([1])
    // Not re-derived by lane K: best found, the bound dropped.
    const dropped = verifiedGoals(costLed, () => ({ proves: false }))
    expect(dropped.word === 'validated feasible' && dropped.goals[1]).toEqual(found(1, 425_050, 'NOK'))
  })

  test('C: a group lead\'s proof stands only when lane K re-derives its bound on the lead\'s own goal', () => {
    const leads: number[] = []
    expect(verifiedGoals(groupLed, proves, bound => { leads.push(bound.value); return { proves: true } })).toEqual(groupLed)
    expect(leads).toEqual([20])
    const refused = verifiedGoals(groupLed, proves, () => ({ proves: false }))
    expect(refused.word === 'validated feasible' && refused.lead).toEqual({ word: 'best found under budget', group: 'AFW-A', value: 20, unit: 'h' })
    // No way to re-derive it given: never stored as proven.
    const unasked = verifiedGoals(groupLed, proves)
    expect(unasked.word === 'validated feasible' && unasked.lead !== undefined && 'word' in unasked.lead ? unasked.lead.word : undefined).toBe('best found under budget')
  })
})
