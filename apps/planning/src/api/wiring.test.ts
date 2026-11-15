// The operations on the REAL solver (lane S's pool and Generate, lane K's checker inside each sub-solve's
// child; the tests below run lane K's code on what was stored, as an independent witness):
// the Train A Definition's inputs (the frozen flagship case, V1 and V2) and result sizes on twin v3. The demo
// as a planner starts it, with World, is packages/integration-tests/tests/planning-train-a.test.ts.
import { afterAll, describe, expect, test } from 'bun:test'
import { planInputsSchema, planSchema, type Plan, type PlanInputs } from '../plan/schema.ts'
import { createSolverPool } from '../solve/pool.ts'
import { bundledPlanDefinitions } from '../definitions/index.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { createHarness, type Answer } from './fixtures/harness.ts'
import { createRealSolver } from './wiring.ts'
import { checkPlan } from '../check/check.ts'
import { verifyCertificate } from '../check/certificate.ts'
import { verifyOptimality } from '../check/optimal.ts'

const pool = createSolverPool()
const harness = await createHarness({ solver: createRealSolver(pool) })
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
    // What the child stored is what lane K's own code finds on the stored rows: feasible, each proof confirmed.
    for (const option of stored.options!.options) {
      if (option.status.word !== 'validated feasible') continue
      expect([option.key, checkPlan(stored.inputs, option.variant, option.rows).feasible]).toEqual([option.key, true])
      expect(verifyOptimality(stored.inputs, option.variant, option.status).every(entry => entry.proves)).toBe(true)
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
    for (const option of stored.options!.options) {
      const shown = options.find(entry => entry.key === option.key)!
      const certificate = option.status.word === 'proven infeasible' ? verifyCertificate(stored.inputs, option.variant, option.status.cause) : undefined
      console.log(`${option.label}: stored ${option.status.word}; lane K proves ${certificate?.proves}; unverified ${JSON.stringify(certificate?.unverified ?? [])}`)
      // The child keeps "proven infeasible" only when lane K's re-verification proves it; the service shows it as stored.
      expect(option.status.word).toBe('proven infeasible')
      expect(shown.status.word).toBe(option.status.word)
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
    for (const option of stored.options!.options) expect(option.status.word === 'proven infeasible' ? verifyCertificate(stored.inputs, option.variant, option.status.cause) : undefined).toMatchObject({ proves: true, unverified: [] })
    expect(options.find(option => option.label.startsWith('V1'))!.status.cause).toMatchObject({ kind: 'chain', requiredHours: 37, availableHours: 32 })
  }, 120_000)

  test('twin v3: Generate refuses it above the certified size in planner words; every result stays within 4 KB', async () => {
    const bench = JSON.parse(await Bun.file(new URL('../../tests/harness/fixtures/twin-v3.json', import.meta.url)).text())
    const twin = twinPlan(bench, twinV3Options(bench))
    const id = await planOf(twin.inputs)
    // 330 jobs per solve against the measured 33: refused before any solve (a 330-job solve is the solver's, called directly).
    const generated = await harness.call('planning.plan.generate', { resource: id, input: { seconds: 8 }, expectedRevision: 1 })
    expect([generated.status, generated.body.error.code]).toEqual([413, 'above_certified_size'])
    expect(generated.body.error.message).toBe('This plan needs 330 jobs in one solve. Planning handles up to 40, and is certified for up to 33 (one system window). Split the work into system windows.')
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

describe('a lock judged on every violation it brings (adversary recheck 3)', () => {
  // Pump X in group G, allowed out 72 h in one span: tag 10 h, work 50 h, test 10 h, chained, on one crew
  // around the clock. Saved: tag 0-10 h, work 10-60 h, test 60-70 h, a 70 h span.
  const at = '2026-11-16T00:00:00Z'
  const planner = { by: 'planner' as const }
  const job = (key: string, kind: 'tag-out' | 'work' | 'test', hours: number): PlanInputs['jobs'][number] => ({
    key, title: `${kind} X`, kind, equipment: ['X'], isolation: kind === 'work' ? 'inside' : 'none', duration: { value: hours, unit: 'h', calendar: 'working', origin: planner },
    durationWith: [], needs: [{ anyOf: ['ops'], amount: 1, handover: false }], continuous: true, checks: [], tags: [],
  })
  const inputs = planInputsSchema.parse({
    settings: { title: 'Span check', timeZone: 'Europe/Oslo', window: { start: at, end: '2026-11-22T00:00:00Z' }, dataDate: at, grid: '30min', currency: 'NOK', run: null },
    equipment: [{ key: 'X', label: 'Pump X', group: 'G', supportedBy: [] }], groups: [{ key: 'G', label: 'Group G' }],
    calendars: [{ key: 'always', label: 'Always', weekly: [], periods: [{ start: at, end: '2026-11-22T00:00:00Z' }], except: [], source: planner }],
    resources: [{ key: 'ops', label: 'Crew', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner }],
    purchases: [], methods: [], jobs: [job('T', 'tag-out', 10), job('W', 'work', 50), job('R', 'test', 10)],
    links: [{ from: 'T', to: 'W', type: 'FS', lag: { value: 0, unit: 'h' } }, { from: 'W', to: 'R', type: 'FS', lag: { value: 0, unit: 'h' } }],
    rules: [{ kind: 'span-limit', key: 'R2', group: 'G', limit: { value: 72, unit: 'h' }, singleEntry: true, words: 'Pump X back and tested within 72 h of its tag-out.', source: planner }],
    goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
  })
  test('the test fixed too early and lengthened to 14 h: every start its links allow breaks the 72 h span, so none is offered', async () => {
    const id = await planOf(inputs)
    const generated = await harness.call('planning.plan.generate', { resource: id, input: {}, expectedRevision: 1 })
    expect(generated.body.result.options[0].status.word).toBe('validated feasible')
    // Before the fix, the saved slot (60 h, links kept) was offered, though there the test ends at 74 h.
    const preview = await harness.call('planning.plan.edit', { resource: id, input: { preview: true, edits: [{ edit: 'job', key: 'R', lock: '2026-11-16T20:00:00Z', duration: { value: 14 } }] } })
    expect(preview.status).toBe(200)
    expect(preview.body.result.preview.nearestAllowed).toBeUndefined()
    expect(preview.body.result.preview.consequence).toContain('No start for test X keeps every rule with the other jobs where the plan has them.')
    // Lengthened only to 12 h, the saved slot keeps the span (72 h): it is offered.
    const fits = await harness.call('planning.plan.edit', { resource: id, input: { preview: true, edits: [{ edit: 'job', key: 'R', lock: '2026-11-16T20:00:00Z', duration: { value: 12 } }] } })
    expect(fits.body.result.preview.nearestAllowed).toBe('2026-11-18T12:00:00.000Z')
  }, 120_000)
})

