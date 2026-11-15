// Increment 2 inputs that the contract takes before their lanes build them are refused with 501 not_built,
// never ignored (adversary review of lane A, R1). Each refusal sits where its owner lifts it: also, lead and
// keep in solve/generate.ts variantsOf (lane S), keep where the service drops it (lane P, api/operations.ts),
// and the explain asks recommended and versus in the real explain (lane P, api/wiring.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import { isPlanningError } from '../errors.ts'
import { bundledPlanDefinitions } from '../definitions/index.ts'
import { planSchema } from '../plan/schema.ts'
import { variantsOf } from '../solve/generate.ts'
import { createSolverPool } from '../solve/pool.ts'
import { createHarness } from './fixtures/harness.ts'
import { createRealSolver } from './wiring.ts'

const pool = createSolverPool()
const real = await createHarness({ solver: createRealSolver(pool) })
const double = await createHarness()
afterAll(async () => { await pool.shutdown(); await real.close(); await double.close() })

const inputs = bundledPlanDefinitions.find(definition => definition.id === 'train-a-work-week')!.inputs
const rule = { kind: 'span-limit' as const, key: 'W48', group: 'COOL-A', limit: { value: 48, unit: 'h' as const }, singleEntry: true, words: 'Train A cooling chain back within 48 h', source: { by: 'planner' as const } }
const refusal = async (run: () => unknown): Promise<unknown> => {
  try { await run(); return 'answered' } catch (error) { return isPlanningError(error) ? [error.status, error.code, error.details] : error }
}

describe('Generate refuses what it does not build yet', () => {
  test('the solver refuses also, lead and keep by name; plain what-ifs still pass', async () => {
    expect(await refusal(() => variantsOf(inputs, { variants: [{ label: 'At most 48 h out', also: [rule] }] }))).toEqual([501, 'not_built', { fields: ['also'] }])
    expect(await refusal(() => variantsOf(inputs, { variants: [{ label: 'Finish AFW A first', lead: { group: 'AFW-A' } }] }))).toEqual([501, 'not_built', { fields: ['lead'] }])
    expect(await refusal(() => variantsOf(inputs, { variants: [{ also: [rule] }, { lead: { goal: 1 } }], keep: true }))).toEqual([501, 'not_built', { fields: ['also', 'lead', 'keep'] }])
    expect(variantsOf(inputs, { variants: [{ label: 'Days only', buy: 'no-extra-crew-hours' }] }).map(variant => variant.label)).toEqual(['Days only'])
  })

  test('on the real solver, an "at most 48 h out" what-if is refused and nothing is stored', async () => {
    const created = await real.create('train-a-work-week')
    const answer = await real.call('planning.plan.generate', { resource: created.id, input: { variants: [{ label: 'At most 48 h out', also: [rule] }] }, expectedRevision: created.revision })
    expect([answer.status, answer.body.error.code]).toEqual([501, 'not_built'])
    const stored = await real.store.read(real.workspaceId, created.id)
    expect([stored.revision, stored.options]).toEqual([created.revision, null])
  })

  test('keep is refused where the service would drop it, and nothing is stored', async () => {
    const created = await double.create('train-a-work-week')
    const answer = await double.call('planning.plan.generate', { resource: created.id, input: { keep: true }, expectedRevision: created.revision })
    expect([answer.status, answer.body.error.code, answer.body.error.details]).toEqual([501, 'not_built', { fields: ['keep'] }])
    expect((await double.store.read(double.workspaceId, created.id)).options).toBeNull()
  })
})

describe('explain refuses what it does not build yet', () => {
  test('recommended and versus are refused, never answered with the finish chain', async () => {
    const [, line] = (await Bun.file(new URL('../plan/fixtures/increment-1-plan.json', import.meta.url)).text()).split('\n')
    const { frozenInputs: _frozen, baselines: _baselines, ...stored } = JSON.parse(line!)
    const plan = planSchema.parse({ ...stored, baselines: [] })
    const option = plan.options!.options[0]!
    const solver = createRealSolver(pool)
    for (const ask of ['recommended', 'versus'] as const) {
      expect(await refusal(() => solver.explain({ inputs: plan.inputs, option, ask, job: undefined, cursor: undefined }))).toEqual([501, 'not_built', { ask }])
    }
    expect((await solver.explain({ inputs: plan.inputs, option, ask: 'finish', job: undefined, cursor: undefined })).items.length).toBeGreaterThan(0)
  }, 60_000)
})
