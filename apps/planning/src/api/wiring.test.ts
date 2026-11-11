// The operations on the REAL solver (lane S's Worker pool and Generate) and checker (lane K's re-check):
// the Train A Definition, the frozen flagship case (V1 and V2), and result sizes on twin v3.
import { afterAll, describe, expect, test } from 'bun:test'
import { planSchema, type Plan, type PlanInputs } from '../plan/schema.ts'
import { createSolverPool } from '../solve/pool.ts'
import { trainAInputs } from '../solve/fixtures/train-a-case.ts'
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
/** The flagship after linking its Run and a refresh: World shows SW B running (the SW A tag-out's precondition). */
const refreshedFlagship = (): PlanInputs => {
  const inputs = trainAInputs()
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
  test('the Train A Definition is the lane A fragment: Generate answers invalid input, naming the unbracketed inside work', async () => {
    const created = await harness.create('train-a-work-week')
    const generated = await harness.call('planning.plan.generate', { resource: created.id, input: { seconds: 6 }, expectedRevision: 1 })
    expect(generated.status).toBe(200)
    small(generated)
    console.log('Train A Definition:', JSON.stringify(summary(generated.body.result.options)), generated.body.result.text)
    expect(generated.body.result.options.map((option: GeneratedOption) => option.status.word)).toEqual(generated.body.result.options.map(() => 'invalid input'))
    expect(created.answer.body.result.problems.map((problem: { code: string }) => problem.code)).toContain('no-tag-out')
  }, 120_000)

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

  test('twin v3: every result stays within 4 KB', async () => {
    const bench = JSON.parse(await Bun.file(new URL('../../tests/harness/fixtures/twin-v3.json', import.meta.url)).text())
    const twin = twinPlan(bench, twinV3Options(bench))
    const id = await planOf(twin.inputs)
    const generated = await harness.call('planning.plan.generate', { resource: id, input: { seconds: 8 }, expectedRevision: 1 })
    expect(generated.status).toBe(200)
    small(generated)
    console.log('Twin v3:', JSON.stringify(summary(generated.body.result.options)), `generate ${generated.bytes} B`)
    const sizes: Record<string, number> = { generate: generated.bytes }
    const recommended = generated.body.result.recommended
    for (const section of ['summary', 'jobs', 'rules', 'crews', 'sources', 'options', ...(recommended === undefined ? [] : ['schedule']), 'history']) {
      const read = await harness.call('planning.plan.read', { resource: id, input: { section } })
      expect([section, read.status]).toEqual([section, 200])
      small(read)
      sizes[section] = read.bytes
    }
    if (recommended !== undefined) {
      for (const ask of ['finish', 'why-start'] as const) {
        const explained = await harness.call('planning.plan.explain', { resource: id, input: { ask } })
        expect(explained.status).toBe(200)
        small(explained)
        sizes[`explain ${ask}`] = explained.bytes
      }
    }
    const edited = await harness.call('planning.plan.edit', { resource: id, input: { edits: [{ edit: 'plan', title: 'Gate twin v3, checked' }] }, expectedRevision: 1 })
    small(edited)
    sizes.edit = edited.bytes
    console.log('Twin v3 result bytes:', JSON.stringify(sizes))
  }, 180_000)
})
