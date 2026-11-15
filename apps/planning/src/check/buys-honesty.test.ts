import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { buysEndSchema, buysRowSchema, buysWordSchema } from '../api/contract.ts'
import { planInputsSchema, planSchema, type PlanInputs } from '../plan/schema.ts'
import { buysHonesty, rungStanding, wordStands, type BuysItem } from '../../tests/harness/buys-honesty.ts'

// "What overtime buys": no difference between rungs is worded stronger than its two ends' proofs allow.
// The ends are lane K's alone: re-checked, re-verified, and "proven" only where the proof fixes the figure the
// row compares (the longest outage). Window Mon 16 Nov 2026 06:00Z to Wed 18 Nov 06:00Z, Europe/Oslo (+1 h).
// Item X in group G: tag-out T (1 h) and test R (1 h) on the operator, around the clock; inside work W, 9 h
// for the fitter, who works 07:00-15:00 local (06:00Z-14:00Z); overtime 15:00-17:00 local (14:00Z-16:00Z) is
// bought at NOK 100 per person-hour.
//   Rung 0, days only: T 06:00Z-07:00Z; W Mon 07:00Z-14:00Z (7 h) and Tue 06:00Z-08:00Z (2 h); R Tue
//   08:00Z-09:00Z. G is out Mon 06:00Z to Tue 09:00Z = 27 h, the least possible: 9 h of day work cannot avoid
//   the 16 h night, and T and R take 1 h each.
//   Rung 1, with overtime: W Mon 07:00Z-14:00Z and 14:00Z-16:00Z bought (2 person-h, NOK 200); R 16:00Z-17:00Z.
//   G is out 06:00Z-17:00Z = 11 h, the least possible: W cannot start before T ends at 07:00Z.
// So the row reads: 11 - 27 = -16 h of outage, +NOK 200.
type Ends = { from: z.infer<typeof buysEndSchema>; to: z.infer<typeof buysEndSchema> }
const planner = { by: 'planner' as const }
const job = (key: string, kind: 'tag-out' | 'work' | 'test', hours: number, resource: string): PlanInputs['jobs'][number] => ({
  key, title: `Job ${key}`, kind, equipment: ['X'], isolation: kind === 'work' ? 'inside' : 'none', duration: { value: hours, unit: 'h', calendar: 'working', origin: planner },
  durationWith: [], needs: [{ anyOf: [resource], amount: 1, handover: false }], continuous: kind !== 'work', checks: [], tags: [],
})
const inputs = (threshold: number, rules: PlanInputs['rules'] = []): PlanInputs => planInputsSchema.parse({
  settings: { title: 'Ladder', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-18T06:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [{ key: 'X', label: 'Item X', group: 'G', supportedBy: [] }], groups: [{ key: 'G', label: 'Group G' }],
  calendars: [
    { key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner },
    { key: 'day', label: 'Day shift', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '15:00' }], periods: [], except: [], source: planner },
    { key: 'late', label: 'Overtime to 17:00', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '15:00', to: '17:00' }], periods: [], except: [], source: planner },
  ],
  resources: [
    { key: 'ops', label: 'Operator', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner },
    { key: 'fitter', label: 'Fitter', kind: 'crew', count: 1, calendar: 'day', attributes: [], source: planner },
  ],
  purchases: [{ key: 'ot', label: 'Fitter overtime', resource: 'fitter', adds: { calendar: 'late' }, replaces: [], price: { perPersonHour: 100 }, allowed: true }],
  methods: [], jobs: [job('T', 'tag-out', 1, 'ops'), job('W', 'work', 9, 'fitter'), job('R', 'test', 1, 'ops')], links: [], rules,
  goals: [
    { metric: 'span-over', scope: { groups: ['G'] }, threshold: { value: threshold, unit: 'h' }, tolerance: { value: 0, unit: 'h' } },
    { metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } },
  ],
  world: { refreshedAt: null, facts: [] },
})
const float = { workingHours: 0, limitedBy: { kind: 'window-end' as const } }
const use = (resource: string, from: string, to: string, purchase?: string) => ({ resource, from, to, ...(purchase === undefined ? {} : { purchase }) })
const rowOf = (key: string, start: string, finish: string, uses: ReturnType<typeof use>[]) => ({ job: key, start, finish, uses, float })
const opsRow = (key: string, start: string, finish: string) => rowOf(key, start, finish, [use('ops', start, finish)])
/** Rung 0, with the test `late` hours after W ends (0: the least outage, 27 h). */
const rung0Rows = (late = 0) => {
  const test = new Date(Date.parse('2026-11-17T08:00:00Z') + late * 3_600_000).toISOString().replace('.000Z', 'Z')
  const end = new Date(Date.parse(test) + 3_600_000).toISOString().replace('.000Z', 'Z')
  return [opsRow('T', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), rowOf('W', '2026-11-16T07:00:00Z', '2026-11-17T08:00:00Z', [use('fitter', '2026-11-16T07:00:00Z', '2026-11-16T14:00:00Z'), use('fitter', '2026-11-17T06:00:00Z', '2026-11-17T08:00:00Z')]), opsRow('R', test, end)]
}
const rung1Rows = [opsRow('T', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), rowOf('W', '2026-11-16T07:00:00Z', '2026-11-16T16:00:00Z', [use('fitter', '2026-11-16T07:00:00Z', '2026-11-16T14:00:00Z'), use('fitter', '2026-11-16T14:00:00Z', '2026-11-16T16:00:00Z', 'ot')]), opsRow('R', '2026-11-16T16:00:00Z', '2026-11-16T17:00:00Z')]
const run = { grid: '30min' as const, engine: 'double', formulation: 'f', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
const proven = (goal: number, value: number, unit: string, certificate: object) => ({ word: 'proven optimal' as const, goal, value, unit, bound: { value, source: 'logic+calendars' as const, certificate } })
const zero = { kind: 'zero' }
const leastSpan = (hours: number) => ({ kind: 'least-span', spans: [{ group: 'G', hours }] })
const found = (goal: number, value: number, unit: string) => ({ word: 'best found under budget' as const, goal, value, unit })
type StoredOption = { key: string; purchases: string[]; status: object; rows: ReturnType<typeof rung0Rows>; inputsRevision?: number }
const stored = (planInputs: PlanInputs, options: StoredOption[]) => planSchema.parse({
  id: '00000000-0000-4000-8000-000000000006', workspaceId: '00000000-0000-4000-8000-0000000000aa', revision: 2, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', inputs: planInputs,
  options: { at: '2026-11-11T00:00:00Z', by: { kind: 'agent' }, options: options.map(option => ({ key: option.key, label: option.key, variant: { methods: [], purchases: option.purchases }, status: option.status, rows: option.rows, metrics: [], inputsRevision: option.inputsRevision ?? 2 })) },
  baselines: [], changes: [], droppedChanges: 0,
})
// Threshold 8 h: rung 0 is 19 h over it, rung 1 3 h; both proven, so each proof fixes its outage (threshold + excess).
const pinned = stored(inputs(8), [
  { key: 'rung-0', purchases: [], status: { word: 'validated feasible', run, goals: [proven(0, 19, 'h', leastSpan(27)), proven(1, 0, 'NOK', zero)] }, rows: rung0Rows() },
  { key: 'rung-1', purchases: ['ot'], status: { word: 'validated feasible', run, goals: [proven(0, 3, 'h', leastSpan(11)), found(1, 200, 'NOK')] }, rows: rung1Rows },
])
const rungs: BuysItem[] = [
  { rung: { rung: 0, buy: [], option: 'rung-0', bought: [] } },
  { rung: { rung: 1, buy: ['ot'], option: 'rung-1', bought: [{ id: 'bought:ot', value: 2, unit: 'person-h' }] } },
]
const row = (word: z.infer<typeof buysWordSchema>, ends: Ends, figures?: { outage: number; cost: number }): BuysItem => ({ row: { from: 0, to: 1, ends, word, ...figures } })
const kinds = (findings: ReturnType<typeof buysHonesty>) => findings.map(finding => finding.kind).sort()

describe('the ends are lane K\'s', () => {
  test('both rungs proven, each proof fixing its outage: 27 h and 11 h, NOK 0 and 200', () => {
    const option = (key: string) => pinned.options!.options.find(entry => entry.key === key)!
    expect(rungStanding(pinned, option('rung-0'), 'f')).toMatchObject({ end: 'proven', outage: 27, cost: 0, bought: [] })
    expect(rungStanding(pinned, option('rung-1'), 'f')).toMatchObject({ end: 'proven', outage: 11, cost: 200, bought: [{ id: 'bought:ot', value: 2, unit: 'person-h' }] })
  })
  test('"proven", 16 h shorter for NOK 200, stands', () => {
    expect(buysHonesty(pinned, [...rungs, row('proven', { from: 'proven', to: 'proven' }, { outage: -16, cost: 200 })], 'f')).toEqual([])
  })
  test('the weaker "found" is true too; "proven: no gain" and "not found better" are not', () => {
    expect(buysHonesty(pinned, [...rungs, row('found', { from: 'proven', to: 'found' }, { outage: -16, cost: 200 })], 'f')).toEqual([])
    expect(kinds(buysHonesty(pinned, [...rungs, row('not found better', { from: 'proven', to: 'proven' }, { outage: -16, cost: 200 })], 'f'))).toEqual(['word'])
  })
  test('a figure that is not the checker\'s own is a finding', () => {
    expect(kinds(buysHonesty(pinned, [...rungs, row('proven', { from: 'proven', to: 'proven' }, { outage: -15, cost: 200 })], 'f'))).toEqual(['figure'])
    expect(kinds(buysHonesty(pinned, [rungs[0]!, { rung: { rung: 1, buy: ['ot'], option: 'rung-1', bought: [] } }, row('proven', { from: 'proven', to: 'proven' }, { outage: -16, cost: 200 })], 'f'))).toEqual(['bought'])
  })
})

describe('no word is stronger than the proofs', () => {
  test('a rung without a proof is "found": "proven" is refused, and so is stating its end as proven', () => {
    const unproven = stored(inputs(8), [
      { key: 'rung-0', purchases: [], status: { word: 'validated feasible', run, goals: [proven(0, 19, 'h', leastSpan(27)), proven(1, 0, 'NOK', zero)] }, rows: rung0Rows() },
      { key: 'rung-1', purchases: ['ot'], status: { word: 'validated feasible', run, goals: [found(0, 3, 'h'), found(1, 200, 'NOK')] }, rows: rung1Rows },
    ])
    expect(kinds(buysHonesty(unproven, [...rungs, row('proven', { from: 'proven', to: 'proven' }, { outage: -16, cost: 200 })], 'f'))).toEqual(['ends', 'word'])
    expect(buysHonesty(unproven, [...rungs, row('found', { from: 'proven', to: 'found' }, { outage: -16, cost: 200 })], 'f')).toEqual([])
  })
  test('a proof the checker cannot re-derive is no proof: rung 1 "proven" at 2 h over, its bound is 3 h over', () => {
    // 2 h claimed with a bound of 2 h, but the rows put G out 11 h (3 h over) and lane K's bound is 3 h
    const overclaimed = stored(inputs(8), [
      { key: 'rung-0', purchases: [], status: { word: 'validated feasible', run, goals: [proven(0, 19, 'h', leastSpan(27)), proven(1, 0, 'NOK', zero)] }, rows: rung0Rows() },
      { key: 'rung-1', purchases: ['ot'], status: { word: 'validated feasible', run, goals: [proven(0, 2, 'h', leastSpan(10)), found(1, 200, 'NOK')] }, rows: rung1Rows },
    ])
    expect(rungStanding(overclaimed, overclaimed.options!.options[1]!, 'f').end).toBe('found')
  })
  test('under the threshold a proof fixes no outage: two "proven optimal" at 0 h over 30 h make no proven difference', () => {
    // Rung 0 here returns X 2 h late (R Tue 10:00Z-11:00Z): out 29 h, still under 30 h, so "proven optimal"
    // at 0 h over, which lane K confirms. Its least outage is 27 h, so "proven: 18 h shorter" would be false.
    const under = stored(inputs(30), [
      { key: 'rung-0', purchases: [], status: { word: 'validated feasible', run, goals: [proven(0, 0, 'h', zero), proven(1, 0, 'NOK', zero)] }, rows: rung0Rows(2) },
      { key: 'rung-1', purchases: ['ot'], status: { word: 'validated feasible', run, goals: [proven(0, 0, 'h', zero), found(1, 200, 'NOK')] }, rows: rung1Rows },
    ])
    expect(rungStanding(under, under.options!.options[0]!, 'f')).toMatchObject({ end: 'found', outage: 29 })
    const claimed = row('proven', { from: 'proven', to: 'proven' }, { outage: -18, cost: 200 })
    expect(kinds(buysHonesty(under, [...rungs, claimed], 'f'))).toEqual(['ends', 'ends', 'word'])
    expect(buysHonesty(under, [...rungs, row('found', { from: 'found', to: 'found' }, { outage: -18, cost: 200 })], 'f')).toEqual([])
  })
  test('"makes it possible" needs a lower rung refused by a certificate lane K re-verifies', () => {
    // A 20 h limit on G: 9 h of day work cannot avoid the 16 h night, so days only are refused; rung 1 keeps it (11 h).
    const certificate = { kind: 'temporal', steps: [{ job: 'T', via: 'window' }, { job: 'W', via: 'bracket' }, { job: 'R', via: 'bracket' }, { job: 'T', via: 'span-limit' }] }
    const limited = (cause: object) => stored(inputs(8, [{ kind: 'span-limit', key: 'L', group: 'G', limit: { value: 20, unit: 'h' }, singleEntry: true, words: 'G back within 20 h', source: planner }]), [
      { key: 'rung-0', purchases: [], status: { word: 'proven infeasible', cause, run }, rows: [] },
      { key: 'rung-1', purchases: ['ot'], status: { word: 'validated feasible', run, goals: [proven(0, 3, 'h', leastSpan(11)), found(1, 200, 'NOK')] }, rows: rung1Rows },
    ])
    const possible = row('makes it possible', { from: 'refused', to: 'proven' })
    expect(buysHonesty(limited(certificate), [...rungs, possible], 'f')).toEqual([])
    // the same refusal with a chain that does not hold: rung 0 is not refused, only unsolved
    const broken = { kind: 'chain', jobs: ['R', 'T'], workHours: 30, calendars: [], availableHours: 1, from: '2026-11-16T06:00:00Z', by: '2026-11-16T07:00:00Z' }
    expect(kinds(buysHonesty(limited(broken), [...rungs, possible], 'f'))).toEqual(['ends', 'word'])
  })
  test('a rung solved on an earlier revision is not solved here', () => {
    const old = stored(inputs(8), [
      { key: 'rung-0', purchases: [], status: { word: 'validated feasible', run, goals: [proven(0, 19, 'h', leastSpan(27)), proven(1, 0, 'NOK', zero)] }, rows: rung0Rows() },
      { key: 'rung-1', purchases: ['ot'], status: { word: 'validated feasible', run, goals: [proven(0, 3, 'h', leastSpan(11)), found(1, 200, 'NOK')] }, rows: rung1Rows, inputsRevision: 1 },
    ])
    // rung 1 is still to solve on this revision, so it names no option
    const toSolve: BuysItem[] = [rungs[0]!, { rung: { rung: 1, buy: ['ot'], bought: [] } }]
    expect(kinds(buysHonesty(old, [...toSolve, row('found', { from: 'proven', to: 'found' }, { outage: -16, cost: 200 })], 'f'))).toEqual(['ends', 'figure', 'word'])
    expect(buysHonesty(old, [...toSolve, row('not solved', { from: 'proven', to: 'unsolved' })], 'f')).toEqual([])
    // naming the stale option as the rung's is itself a finding
    expect(kinds(buysHonesty(old, [...rungs, row('not solved', { from: 'proven', to: 'unsolved' })], 'f'))).toEqual(['rung'])
  })
})

describe('the contract never accepts a word its stated ends do not carry', () => {
  // Every word, every pair of ends, every outage sign (and none): what the contract parses must stand.
  const ends = buysEndSchema.options
  const outages = [undefined, -1, 0, 1]
  const finish = { kind: 'crew' as const, about: [{ kind: 'resource' as const, key: 'fitter' }] }
  const accepted: string[] = []
  for (const word of buysWordSchema.options) for (const from of ends) for (const to of ends) for (const outage of outages) {
    const candidate = { from: 0, to: 1, ends: { from, to }, word, ...(outage === undefined ? {} : { outage, cost: 0 }), ...(word === 'proven: no gain' ? { finish } : {}) }
    if (buysRowSchema.safeParse(candidate).success) accepted.push(`${word}|${from}|${to}|${outage}`)
  }
  test('some rows parse, so the sweep sees the contract', () => {
    expect(accepted.length).toBeGreaterThan(8)
  })
  test('each parsed row\'s word stands on its stated ends and outage', () => {
    const wrong = accepted.filter(key => {
      const [word, from, to, outage] = key.split('|') as [z.infer<typeof buysWordSchema>, Ends['from'], Ends['to'], string]
      return !wordStands(word, { from, to }, outage === 'undefined' ? undefined : Number(outage))
    })
    expect(wrong).toEqual([])
  })
})
