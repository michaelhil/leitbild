// The operations on the REAL solver (lane S's Worker pool and Generate) and checker (lane K's re-check):
// the Train A Definition's inputs (the frozen flagship case, V1 and V2) and result sizes on twin v3. The demo
// as a planner starts it, with World, is packages/integration-tests/tests/planning-train-a.test.ts.
import { afterAll, describe, expect, test } from 'bun:test'
import { planSchema, type Plan, type PlanInputs } from '../plan/schema.ts'
import { createSolverPool } from '../solve/pool.ts'
import { bundledPlanDefinitions } from '../definitions/index.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { createHarness, type Answer } from './fixtures/harness.ts'
import { createRealSolver, realChecker } from './wiring.ts'

const pool = createSolverPool()
const harness = await createHarness({ solver: createRealSolver(pool), checker: realChecker })
afterAll(async () => { await pool.shutdown(); await harness.close() })
const small = (answer: Answer) => expect(answer.bytes).toBeLessThanOrEqual(4_096)

/** A plan of the given inputs, stored as create would store it (the flagship case is not a Definition). */
const planOf = async (inputs: PlanInputs): Promise<string> => {
  const at = new Date().toISOString()
  const plan: Plan = planSchema.parse({
    id: crypto.randomUUID(), workspaceId: harness.workspaceId, revision: 1, createdAt: at, updatedAt: at, inputs, options: null, baselines: [],
    changes: [{ seq: 1, at, by: { kind: 'human' }, revision: 1, summary: `Created '${inputs.settings.title}'`, kinds: [] }], droppedChanges: 0,
  })
  return (await harness.store.create(harness.workspaceId, plan)).id
}
/** The Train A Definition after linking its Run and a refresh: World shows each precondition as expected. */
const refreshedFlagship = (): PlanInputs => {
  const inputs = bundledPlanDefinitions.find(definition => definition.id === 'train-a-work-week')!.inputs
  const at = inputs.settings.dataDate ?? inputs.settings.window!.start
  const facts = inputs.jobs.flatMap(job => job.checks.map(check => ({
    id: check.fact, label: check.words, quantity: 'state', value: check.expect, basis: 'observed' as const, at,
    locator: inputs.equipment.find(item => item.key === check.equipment)!.locator!,
  })))
  return { ...inputs, settings: { ...inputs.settings, run: { id: 'run-train-a', linkedAt: at } }, world: { refreshedAt: at, facts } }
}
type GeneratedOption = { key: string; label: string; status: { word: string; goals: Array<{ word: string; value: number; unit: string }>; cause?: { kind: string; requiredHours?: number; availableHours?: number } }; span?: number; cost?: number; warnings: unknown[] }
const summary = (options: GeneratedOption[]) => options.map(option => ({ label: option.label, word: option.status.word, span: option.span, cost: option.cost, goals: option.status.goals.map(goal => `${goal.value} ${goal.unit} (${goal.word})`), warnings: option.warnings.length }))

describe('the operations on the real solver and checker', () => {
  test('the flagship case: Generate, explain and the schedule read, every status re-checked', async () => {
    const id = await planOf(refreshedFlagship())
    const generated = await harness.call('planning.plan.generate', { resource: id, input: {}, expectedRevision: 1 })
    expect(generated.status).toBe(200)
    small(generated)
    const options: GeneratedOption[] = generated.body.result.options
    console.log('Flagship:', JSON.stringify(summary(options)), generated.body.result.text)
    const recommended = options.find(option => option.key === generated.body.result.recommended)
    expect(recommended?.status.word).toBe('validated feasible')
    // Train A's cooling chain is one train in series: no redundancy warning.
    expect(options.map(option => option.warnings)).toEqual(options.map(() => []))
    const stored = await harness.store.read(harness.workspaceId, id)
    for (const option of stored.options!.options) {
      const recheck = realChecker.recheck(stored, option, createRealSolver(pool).formulation(stored.inputs.settings.grid))
      expect([option.key, recheck.usable]).toEqual([option.key, true])
    }
    for (const ask of ['finish', 'why-start'] as const) {
      const explained = await harness.call('planning.plan.explain', { resource: id, input: { ask } })
      expect(explained.status).toBe(200)
      small(explained)
      expect(explained.body.result.items.length).toBeGreaterThan(0)
    }
    for (const section of ['summary', 'options', 'schedule', 'jobs']) small(await harness.call('planning.plan.read', { resource: id, input: { section } }))
  }, 120_000)

  test('V1 and V2 (days only, rebuild and swap): refusals shown as proven only when lane K verifies them, with the cause in hours', async () => {
    const id = await planOf(refreshedFlagship())
    const variants = [
      { label: 'V1 days only, rebuild', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' },
      { label: 'V2 days only, swap', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'no-extra-crew-hours' },
    ]
    const generated = await harness.call('planning.plan.generate', { resource: id, input: { variants, seconds: 10 }, expectedRevision: 1 })
    expect(generated.status).toBe(200)
    small(generated)
    const options: GeneratedOption[] = generated.body.result.options
    console.log('V1/V2:', JSON.stringify(options.map(option => ({ label: option.label, word: option.status.word, cause: option.status.cause }))))
    const stored = await harness.store.read(harness.workspaceId, id)
    const formulation = createRealSolver(pool).formulation(stored.inputs.settings.grid)
    for (const option of stored.options!.options) {
      const shown = options.find(entry => entry.key === option.key)!
      const recheck = realChecker.recheck(stored, option, formulation)
      console.log(`${option.label}: solver ${option.status.word}; lane K proves ${recheck.certificate?.proves}; unverified ${JSON.stringify(recheck.certificate?.unverified ?? [])}`)
      // The stored refusal is a certificate (lane S); it is shown as proven only when lane K's re-verification proves it.
      expect(option.status.word).toBe('proven infeasible')
      expect(shown.status.word).toBe(recheck.certificate?.proves === true && recheck.usable ? 'proven infeasible' : 'unresolved')
      const refusal = await harness.call('planning.plan.explain', { resource: id, input: { ask: 'refusal', option: option.key } })
      small(refusal)
      if (shown.status.word === 'proven infeasible') {
        expect(refusal.status).toBe(200)
        console.log(`${option.label}:`, refusal.body.result.lines.join(' | '))
        expect(refusal.body.result.lines.join(' ')).toMatch(/Not possible: .*\d h/)
      } else {
        // A refusal lane K does not verify is no proof, so it is not explained as one.
        expect([refusal.status, refusal.body.error.code]).toEqual([409, 'option_stale'])
      }
    }
    // V1 and V2 are proven and verified with nothing unverified, each with its cause in hours.
    expect(options.map(option => option.status.word)).toEqual(['proven infeasible', 'proven infeasible'])
    for (const option of stored.options!.options) expect(realChecker.recheck(stored, option, formulation).certificate).toMatchObject({ proves: true, unverified: [] })
    expect(options.find(option => option.label.startsWith('V1'))!.status.cause).toMatchObject({ kind: 'chain', requiredHours: 37, availableHours: 32 })
  }, 120_000)

  test('twin v3: Generate refuses it above the certified size in planner words; every result stays within 4 KB', async () => {
    const bench = JSON.parse(await Bun.file(new URL('../../tests/harness/fixtures/twin-v3.json', import.meta.url)).text())
    const twin = twinPlan(bench, twinV3Options(bench))
    const id = await planOf(twin.inputs)
    // 330 jobs per solve against the measured 33: refused before any solve (a 330-job solve is the solver's, called directly).
    const generated = await harness.call('planning.plan.generate', { resource: id, input: { seconds: 8 }, expectedRevision: 1 })
    expect([generated.status, generated.body.error.code]).toEqual([413, 'above_certified_size'])
    expect(generated.body.error.message).toBe('This plan has 330 jobs. Planning is certified for plans of up to 33 jobs (one system window); larger plans wait for the owner\'s decision.')
    small(generated)
    const sizes: Record<string, number> = { generate: generated.bytes }
    for (const section of ['summary', 'jobs', 'rules', 'crews', 'sources', 'options', 'history']) {
      const read = await harness.call('planning.plan.read', { resource: id, input: { section } })
      expect([section, read.status]).toEqual([section, 200])
      small(read)
      sizes[section] = read.bytes
    }
    const edited = await harness.call('planning.plan.edit', { resource: id, input: { edits: [{ edit: 'plan', title: 'Gate twin v3, checked' }] }, expectedRevision: 1 })
    small(edited)
    sizes.edit = edited.bytes
    console.log('Twin v3 result bytes:', JSON.stringify(sizes))
  }, 180_000)
})

describe("lane K's bound check through the real checker port", () => {
  // A then B on one operator, 1 h each, window from 06:00Z: nothing finishes before 2 h in. A stored claim of
  // "proven optimal" at 3 h is one lane K's own bound (2 h) cannot confirm.
  const job = (key: string): PlanInputs['jobs'][number] => ({
    key, title: key, kind: 'work', equipment: [], isolation: 'none', duration: { value: 1, unit: 'h', calendar: 'working', origin: { by: 'planner' } },
    durationWith: [], needs: [{ anyOf: ['ops'], amount: 1, handover: false }], continuous: true, checks: [], tags: [],
  })
  const row = (key: string, from: string, to: string) => ({ job: key, start: from, finish: to, uses: [{ resource: 'ops', from, to }], float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } } })
  const run = { grid: '30min' as const, engine: 'double', formulation: 'f', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
  const claimed = (value: number) => ({ word: 'validated feasible' as const, run, goals: [{ word: 'proven optimal' as const, goal: 0, value, unit: 'h', bound: { value, source: 'logic+calendars' as const } }] })
  const stored = (status: ReturnType<typeof claimed>, rows: ReturnType<typeof row>[]): Plan => planSchema.parse({
    id: '00000000-0000-4000-8000-000000000004', workspaceId: '00000000-0000-4000-8000-0000000000aa', revision: 1, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
    inputs: {
      settings: { title: 'Bound check', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00Z', end: '2026-11-16T12:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
      equipment: [], groups: [], purchases: [], methods: [], rules: [], world: { refreshedAt: null, facts: [] },
      calendars: [{ key: 'always', label: 'Always', weekly: [], periods: [{ start: '2026-11-16T06:00:00Z', end: '2026-11-16T12:00:00Z' }], except: [], source: { by: 'planner' } }],
      resources: [{ key: 'ops', label: 'Operator', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: { by: 'planner' } }],
      jobs: [job('A'), job('B')], links: [{ from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'h' } }], goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }],
    },
    options: { at: '2026-11-11T00:00:00Z', by: { kind: 'agent' }, options: [{ key: 'o', label: 'Option', variant: { methods: [], purchases: [] }, status, rows, metrics: [], inputsRevision: 1 }] },
    baselines: [], changes: [], droppedChanges: 0,
  })
  test('an unconfirmable "proven optimal" reaches the operations as bestFoundGoals; a confirmed one does not', () => {
    const late = stored(claimed(3), [row('A', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), row('B', '2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z')])
    expect(realChecker.recheck(late, late.options!.options[0]!, 'f')).toMatchObject({ usable: true, bestFoundGoals: [0] })
    const tight = stored(claimed(2), [row('A', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), row('B', '2026-11-16T07:00:00Z', '2026-11-16T08:00:00Z')])
    expect(realChecker.recheck(tight, tight.options!.options[0]!, 'f')).toMatchObject({ usable: true, bestFoundGoals: [] })
  })
})
