import { describe, expect, test } from 'bun:test'
import { planInputsSchema, planSchema, type PlanInputs } from '../plan/schema.ts'
import { verifyCertificate } from './certificate.ts'
import type { CheckVariant } from './check.ts'
import { recheckOption } from './recheck.ts'
import { trainAInputs } from '../../tests/harness/train-a-case.ts'
import caseJson from '../../tests/harness/fixtures/train-a-case-v0.2.json'

// Certificates are re-derived from the inputs. The flagship figures come from the frozen case: V1's chain
// (motor out 3, pump out 5, rebuild 20, pump in 4, motor in 3, reconnect 2 = 37 h) from the crane's arrival,
// Tue 07:00 local, against the day shifts Tue to Fri, 4 x 8 = 32 h (maint/case-v0.2.json, variant V1).
const daysOnly = (method: string) => trainAInputs(caseJson, { method, overtime: false, nights: [], craneFriday: true, ectFriday: true })
const chain = ['SWA-MOTOR-OUT', 'SWA-PUMP-OUT', 'SWA-REBUILD', 'SWA-PUMP-IN', 'SWA-MOTOR-IN', 'SWA-MOTOR-CONN']
const v1 = (from: string) => ({ kind: 'chain' as const, jobs: chain, workHours: 37, calendars: ['day'], availableHours: 32, from, by: '2026-11-21T06:00:00Z' })

describe('V1 and V2 on the flagship', () => {
  test('V1: a lift needs a crew and the crane at once, so the chain is proven, 37 h against 32 h', () => {
    const { inputs, variant } = daysOnly('M1-rebuild')
    const result = verifyCertificate(inputs, variant, v1('2026-11-17T06:00:00Z'))
    expect(result).toMatchObject({ proves: true, ok: true, problems: [], unverified: [], figures: { workHours: 37, availableHours: 32 } })
  })
  test('V1 counted from Monday is refused: the chain\'s jobs can work 40 h from Mon 07:00', () => {
    const { inputs, variant } = daysOnly('M1-rebuild')
    const result = verifyCertificate(inputs, variant, v1('2026-11-16T06:00:00Z'))
    expect(result.ok).toBe(false)
    expect(result.proves).toBe(false)
    expect(result.figures.availableHours).toBe(40)
  })
  test('V2: the checker\'s own time logic rules out both ECT bookings, so a refusal re-verifies', () => {
    const { inputs, variant } = daysOnly('M2-swap')
    const temporal = verifyCertificate(inputs, variant, { kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'window' }, { job: 'SWA-MOTOR-DISC', via: 'link' }] })
    expect(temporal).toMatchObject({ proves: true, unverified: [] })
    expect(temporal.refutedByTime).toHaveLength(2)
  })
  test('V2\'s time refusal is worded for a planner: the span, its limit, and the jobs and shifts that set it', () => {
    const { inputs, variant } = daysOnly('M2-swap')
    const [wednesday, friday] = verifyCertificate(inputs, variant, { kind: 'temporal', steps: [] }).refutedByTime
    // ECT on its Wednesday booking: the cooling-chain span must open by Tue 07:00 local (06:00Z) for the
    // heat-exchanger chain to reach the Wednesday test, and from its shortest opening, Mon 11:00, the tests
    // end Thu 19:30: 80.5 h, over the 72 h limit
    expect(wednesday).toContain('Train A cooling chain (SW A, CCW A and HX A, RHR A, HHSI A) would be out at least 80.5 h, against its 72 h limit')
    expect(wednesday).toContain('The span must open by Tue 17 Nov 06:00')
    expect(wednesday).toContain("'Eddy-current test of CCW HX A tubes' 8 h unbroken in Eddy-current team booked, Wed 18 Nov 07:00 to Wed 18 Nov 15:00")
    expect(wednesday).toContain("'Restore RHR A, pump test on recirculation' 2.5 h unbroken in 24/7 shift operation, Thu 19 Nov 17:00 to Thu 19 Nov 19:30")
    // ECT rebooked to Friday: closing the heat exchanger after it no longer fits in Friday's day shift
    expect(friday).toContain("'Close CCW HX A channel heads with new gaskets' 4 h in Day shift, which no longer fits before the window closes Sat 21 Nov 07:00")
    expect(`${wednesday} ${friday}`).not.toMatch(/earliest start is after its latest start/)
  })
  test('swap with overtime and nights, where or found plans: no refusal re-verifies, and recheck shows "unresolved"', () => {
    const { inputs, variant } = trainAInputs(caseJson, { method: 'M2-swap', overtime: true, nights: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'], craneFriday: true, ectFriday: true })
    const mechanical = inputs.jobs.filter(job => job.method?.option !== 'M1-rebuild' && job.needs.some(need => need.anyOf.includes('mech-station'))).map(job => job.key)
    const energy = { kind: 'energy' as const, resources: ['mech-station', 'mech-contractor'], jobs: mechanical, requiredHours: 60, availableHours: 24, from: '2026-11-16T06:00:00Z', to: '2026-11-16T18:00:00Z' }
    const verified = verifyCertificate(inputs, variant, energy)
    expect(verified.ok).toBe(true)                     // the figures are not wrong as such ...
    expect(verified.unverified.length).toBeGreaterThan(0)   // ... but nothing forces that work into Monday
    expect(verified.proves).toBe(false)
    expect(verifyCertificate(inputs, variant, { kind: 'temporal', steps: [] }).unverified.length).toBeGreaterThan(0)
    const run = { grid: '30min' as const, engine: 'double', formulation: 'f-1', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
    const plan = planSchema.parse({
      id: '00000000-0000-4000-8000-000000000002', workspaceId: '00000000-0000-4000-8000-0000000000aa', revision: 1, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', inputs,
      options: { at: '2026-11-11T00:00:00Z', by: { kind: 'agent' }, options: [{ key: 'o1', label: 'Swap', variant, status: { word: 'proven infeasible', cause: energy, run }, rows: [], metrics: [], inputsRevision: 1 }] },
      baselines: [], changes: [], droppedChanges: 0,
    })
    expect(recheckOption(plan, plan.options!.options[0]!, 'f-1')).toMatchObject({ usable: false, baselineAllowed: false, reasons: ['certificate-unverified'], shownAs: 'unresolved' })
  })
})

// Small plans for the energy and availability arguments. Window Mon 16 Nov 06:00Z-Wed 18 Nov 06:00Z.
const planner = { by: 'planner' as const }
const job = (key: string, kind: 'tag-out' | 'work' | 'test', equipment: string[], hours: number, crew: string, extra: Partial<PlanInputs['jobs'][number]> = {}): PlanInputs['jobs'][number] => ({
  key, title: key, kind, equipment, isolation: kind === 'work' && equipment.length > 0 ? 'inside' : 'none', duration: { value: hours, unit: 'h', calendar: 'working', origin: planner },
  durationWith: [], needs: [{ anyOf: [crew], amount: 1, handover: false }], continuous: kind !== 'work', checks: [], tags: [], ...extra,
})
const small = (fields: Partial<PlanInputs>): PlanInputs => planInputsSchema.parse({
  settings: { title: 'Certificates', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-18T06:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [], groups: [],
  calendars: [{ key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner }],
  resources: [
    { key: 'ops', label: 'Operators', kind: 'crew', count: 2, calendar: 'always', attributes: [], source: planner },
    { key: 'mech', label: 'Mechanical crew', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner },
  ],
  purchases: [], methods: [], jobs: [], links: [], rules: [], goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
  ...fields,
})
const none = { methods: [], purchases: [] }

describe('energy and availability are re-derived, not taken on trust', () => {
  // P and Q in group G, each tag 1 h, inside work 3 h on the one mechanical crew, test 1 h. Each fits a
  // 5 h span alone, and in time both fit together; but 6 h of mechanical work cannot fit any 5 h window.
  const group = (limit: number) => small({
    equipment: [{ key: 'P', label: 'P', group: 'G', supportedBy: [] }, { key: 'Q', label: 'Q', group: 'G', supportedBy: [] }], groups: [{ key: 'G', label: 'Group G' }],
    jobs: [job('P-TAG', 'tag-out', ['P'], 1, 'ops'), job('P-W', 'work', ['P'], 3, 'mech'), job('P-TEST', 'test', ['P'], 1, 'ops'), job('Q-TAG', 'tag-out', ['Q'], 1, 'ops'), job('Q-W', 'work', ['Q'], 3, 'mech'), job('Q-TEST', 'test', ['Q'], 1, 'ops')],
    rules: [{ kind: 'span-limit', key: 'L', group: 'G', limit: { value: limit, unit: 'h' }, singleEntry: true, words: `G back within ${limit} h`, source: planner }],
  })
  const energy = (available: number) => ({ kind: 'energy' as const, resources: ['mech'], jobs: ['P-W', 'Q-W'], requiredHours: 6, availableHours: available, from: '2026-11-16T06:00:00Z', to: '2026-11-16T11:00:00Z', span: 'G' })
  test('in every 5 h window the span could open, 6 h of work against 5 h: proven', () => {
    expect(verifyCertificate(group(5), none, energy(5))).toMatchObject({ proves: true, unverified: [], refutedByTime: [], figures: { requiredHours: 6, availableHours: 5 } })
  })
  test('with a 7 h limit the same count proves nothing and stays unverified', () => {
    const result = verifyCertificate(group(7), none, energy(5))
    expect(result.unverified.length).toBeGreaterThan(0)
    expect(result.proves).toBe(false)
  })
  test('an availability certificate holds only where every schedule has the items out together', () => {
    const forced = (locked: boolean) => small({
      equipment: [{ key: 'A', label: 'A', supportedBy: [] }, { key: 'B', label: 'B', supportedBy: [] }],
      jobs: [
        job('A-TAG', 'tag-out', ['A'], 1, 'ops', locked ? { lock: { start: '2026-11-16T06:00:00Z' } } : {}),
        job('A-TEST', 'test', ['A'], 1, 'ops', { notBefore: { at: '2026-11-16T09:00:00Z', words: 'After the cool-down', source: planner } }),
        job('B-TAG', 'tag-out', ['B'], 1, 'ops', locked ? { lock: { start: '2026-11-16T07:00:00Z' } } : {}),
        job('B-TEST', 'test', ['B'], 1, 'ops', { notBefore: { at: '2026-11-16T09:00:00Z', words: 'After the cool-down', source: planner } }),
      ],
      rules: [{ kind: 'keep-in-service', key: 'K', members: [{ equipment: 'A' }, { equipment: 'B' }], atLeast: 1, words: 'Keep A or B in service', source: planner }],
    })
    // locked tags at 06:00Z and 07:00Z, tests no earlier than 09:00Z-10:00Z: both out 07:00Z-10:00Z in every schedule
    const certificate = { kind: 'availability' as const, rule: 'K', items: ['A', 'B'], from: '2026-11-16T07:00:00Z', to: '2026-11-16T10:00:00Z' }
    expect(verifyCertificate(forced(true), none, certificate)).toMatchObject({ proves: true, unverified: [] })
    expect(verifyCertificate(forced(false), none, certificate).proves).toBe(false)
  })
})

describe("lane S's real generate", () => {
  // The flagship as lane S's fixture converts it; V1 = rebuild, days only. The checker is the real one.
  test('V1 comes back proven infeasible, and its chain certificate re-verifies with nothing unverified', async () => {
    const { generate } = await import('../solve/generate.ts')
    const { searchEngine } = await import('../solve/search.ts')
    const { trainAInputs: laneSTrainA } = await import('../solve/fixtures/train-a-case.ts')
    const { checkPlan } = await import('./check.ts')
    const inputs = laneSTrainA({ read: true })
    const check = ({ inputs: planned, variant, rows }: { readonly inputs: PlanInputs; readonly variant: CheckVariant; readonly rows: Parameters<typeof checkPlan>[2] }) => {
      const result = checkPlan(planned, variant, rows)
      return { violations: result.violations, goals: result.goals.map(goal => 'value' in goal ? goal.value : goal.spans.map(span => span.value)) }
    }
    const result = await generate({ engine: searchEngine(), check, verify: verifyCertificate }, {
      inputs, revision: 1, previous: null, by: { kind: 'agent' }, signal: new AbortController().signal,
      input: { variants: [{ label: 'V1', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' }], seconds: 2 },
    })
    const option = result.optionSet.options[0]!
    if (option.status.word !== 'proven infeasible') throw new Error(`V1 came back ${option.status.word}`)
    expect(option.status.cause.kind).toBe('chain')
    const verified = verifyCertificate(inputs, option.variant, option.status.cause)
    expect(verified).toMatchObject({ proves: true, ok: true, problems: [], unverified: [] })
    // its chain ends Fri 15:00, before the window end: the checker's own time logic rules out every case
    expect(verified.refutedByTime.length).toBeGreaterThan(0)
  }, 30_000)
})
