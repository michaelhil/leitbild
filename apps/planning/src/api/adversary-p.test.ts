// Lane P's part of the fixes from the adversary's attack on the walk fix round (impl/inc23/batch2-adversary-fixes.md):
// B1, an Agent told out-of-date statuses are current; B3, a refused what-if speaking through one method's proof.
// Each from the adversary's own repro.
import { afterAll, describe, expect, test } from 'bun:test'
import { verifyCertificate } from '../check/certificate.ts'
import { optionSchema } from '../plan/schema.ts'
import { explainRefusal } from '../solve/explain.ts'
import { withExtraRules } from '../solve/keys.ts'
import { createSolverPool } from '../solve/pool.ts'
import { sectionDataSchemas } from './contract.ts'
import { createSolverDouble } from './fixtures/doubles.ts'
import { formulation, planWith, rebuild, swap, trainAInputs, type Option } from './fixtures/choose.ts'
import { createHarness } from './fixtures/harness.ts'
import { createRealSolver } from './wiring.ts'

const pool = createSolverPool()
const real = await createHarness({ solver: createRealSolver(pool) })
const double = await createHarness({ solver: { ...createSolverDouble(), formulation: () => formulation } })
afterAll(async () => { await pool.shutdown(); await real.close(); await double.close() })

// The adversary's what-if: "at most 40 h out" for the Train A cooling chain, keyed as the screen keys it.
const at40 = { kind: 'span-limit' as const, key: 'what-if-COOL-A-40h', group: 'COOL-A', limit: { value: 40, unit: 'h' as const }, singleEntry: true, words: 'Train A cooling chain back within 40 h', source: { by: 'planner' as const } }
const label = (option: Option) => trainAInputs.methods[0]!.options.find(entry => entry.key === option.variant.methods[0]!.option)!.label
/** The 40 h what-if refused for every method, each method's cause the bounds' certificate on the inputs with the rule, as lane K re-verifies it. */
const refused40 = (): Option => {
  const ruled = withExtraRules(trainAInputs, [at40])
  const byMethod = [rebuild, swap].map(option => {
    const refusal = explainRefusal(ruled, { methods: option.variant.methods, buy: 'allowed' }, verifyCertificate)
    if (refusal === undefined || !refusal.proves) throw new Error(`${label(option)} is not refused at 40 h`)
    const purchases = trainAInputs.purchases.filter(purchase => purchase.allowed).map(purchase => purchase.key)
    return { methods: option.variant.methods.map(pick => ({ ...pick })), purchases, cause: refusal.cause }
  })
  const run = rebuild.status.word === 'validated feasible' ? rebuild.status.run : undefined
  return optionSchema.parse({
    key: 'what-if-40', label: 'At most 40 h out', variant: { methods: byMethod[0]!.methods, purchases: byMethod[0]!.purchases, also: [at40] },
    status: { word: 'proven infeasible', cause: byMethod[0]!.cause, run, byMethod }, rows: [], metrics: [], inputsRevision: 3,
  })
}

describe('B1: the read says what a status of an earlier plan is, and the data agrees', () => {
  test('ask at most 40 h out, edit an estimate, read: every status is the earlier plan\'s, and the description says so', async () => {
    const plan = await double.store.create(double.workspaceId, planWith(double.workspaceId, [swap, rebuild, refused40()]))
    const job = trainAInputs.jobs.find(entry => entry.title === 'Rebuild SW A bowl assembly in workshop')!
    expect((await double.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'job', key: job.key, duration: { value: 30, unit: 'h' } }] }, expectedRevision: plan.revision })).status).toBe(200)
    const pages = []
    let cursor: string | undefined
    do {
      const data = sectionDataSchemas.options.parse((await double.call('planning.plan.read', { resource: plan.id, input: { section: 'options', ...(cursor === undefined ? {} : { cursor }) } })).body.result.sections[0].data)
      pages.push(data)
      cursor = data.more
    } while (cursor !== undefined)
    const items = pages.flatMap(data => data.items)
    // The data: the 40 h refusal as stored, the recommended option the earlier set's, none of them fresh.
    expect(items.map(item => [item.key, item.status.word, item.fresh])).toEqual([[swap.key, 'validated feasible', false], [rebuild.key, 'validated feasible', false], ['what-if-40', 'proven infeasible', false]])
    expect(pages[0]!.recommended).toBe(swap.key)
    // The description an Agent reads says exactly that.
    const capabilities = (await double.request(`/internal/workspaces/${double.workspaceId}/capabilities`)).body.capabilities as Array<{ id: string; description: string }>
    const read = capabilities.find(entry => entry.id === 'planning.plan.read')!.description
    expect(read).not.toContain('checked again against the plan as it is now')
    expect(read).toContain('a status with fresh false, and the recommended option when its own is not fresh, describe the plan before a later change, not the plan as it is now')
  })
})

