// Lane P's part of the increment 2 walk fix round (impl/inc23/batch2-walk-fix-round.md, from maint/walk-inc2.md):
// V4 the estimate preview on the option the planner has on the timeline; V9 the what-if keep rule as stored;
// V11 the out-of-date count of the plan's own options. On the real solver and checker where the walk was.
import { afterAll, describe, expect, test } from 'bun:test'
import { createSolverPool } from '../solve/pool.ts'
import { createRealSolver } from './wiring.ts'
import { createSolverDouble } from './fixtures/doubles.ts'
import { formulation, ladderFor, planWith, rebuild, swap, trainAInputs, variantOf } from './fixtures/choose.ts'
import { sectionDataSchemas } from './contract.ts'
import { createHarness } from './fixtures/harness.ts'
import { summarize } from '../plan/store.ts'
import { optionSchema } from '../plan/schema.ts'

const pool = createSolverPool()
const real = await createHarness({ solver: createRealSolver(pool) })
const double = await createHarness({ solver: { ...createSolverDouble(), formulation: () => formulation } })
afterAll(async () => { await pool.shutdown(); await real.close(); await double.close() })

const also = (hours: number) => ({ kind: 'span-limit' as const, key: `W${hours}`, group: 'COOL-A', limit: { value: hours, unit: 'h' as const }, singleEntry: true, words: `Train A cooling chain back within ${hours} h`, source: { by: 'planner' as const } })

describe('V4: the estimate preview runs on the option on the timeline, and says so', () => {
  // The walk: Rebuild on the timeline, "Rebuild SW A bowl assembly in workshop" from 20 h to 30 h, Preview.
  const job = trainAInputs.jobs.find(entry => entry.title === 'Rebuild SW A bowl assembly in workshop')!
  const edits = [{ edit: 'job', key: job.key, duration: { value: 30, unit: 'h' } }]

  test('on Rebuild the preview runs on Rebuild and names it; the walk\'s 30 h is lane S\'s refusal on Rebuild, never "no job moves"', async () => {
    // Which option each preview is re-timed on, as the solver receives it.
    const solver = createRealSolver(pool)
    const seen: string[] = []
    const local = await createHarness({ solver: { ...solver, preview: async request => { seen.push(request.option.key); return solver.preview(request) } } })
    try {
      const plan = await local.store.create(local.workspaceId, planWith(local.workspaceId, [swap, rebuild]))
      // A job of Rebuild with float: the jobs after it move, said on Rebuild.
      const tag = trainAInputs.jobs.find(entry => entry.key === 'CSA-TAG')!
      const moved = await local.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'job', key: tag.key, duration: { value: tag.duration.value! + 1, unit: tag.duration.unit } }], preview: true, option: rebuild.key } })
      console.log('V4 on Rebuild:', moved.body.result.preview.consequence)
      expect(moved.body.result.preview.consequence).toMatch(/^Not saved yet\. On 'Rebuild in place': \d+ jobs? moves?; the last finish /)
      expect(moved.body.result.preview.moved.length).toBeGreaterThan(0)
      // The walk's case: the preview is now made on Rebuild. Lane S's repair path then cannot place the pump install
      // within the horizon and refuses, naming it; it is never the swap's "no job moves".
      const walk = await local.call('planning.plan.edit', { resource: plan.id, input: { edits, preview: true, option: rebuild.key } })
      console.log('V4 walk case on Rebuild:', walk.status, walk.body.error?.message ?? walk.body.result.preview.consequence)
      expect(JSON.stringify(walk.body)).not.toMatch(/[Nn]o job moves/)
      expect(seen).toEqual([rebuild.key, rebuild.key])
    } finally { await local.close() }
  }, 60_000)

  test('on the recommended Swap, which has no such job, it says so as a fact, never "no job moves"', async () => {
    const plan = await real.store.create(real.workspaceId, planWith(real.workspaceId, [swap, rebuild]))
    expect(swap.rows.some(row => row.job === job.key)).toBe(false)
    const answer = await real.call('planning.plan.edit', { resource: plan.id, input: { edits, preview: true } })
    expect(answer.body.result.preview.consequence).toBe(`Not saved yet. '${job.title}' is not part of 'Swap in refurbished spare', so this preview cannot show what the change does to it: preview it on an option with that job, or generate after saving.`)
    // An option named without preview is refused, never ignored.
    const refused = await real.call('planning.plan.edit', { resource: plan.id, input: { edits, option: rebuild.key }, expectedRevision: plan.revision })
    expect([refused.status, refused.body.error.code]).toEqual([400, 'invalid_request'])
    expect((await real.call('planning.plan.edit', { resource: plan.id, input: { edits, preview: true, option: 'nowhere' } })).body.error.code).toBe('unknown_reference')
  }, 60_000)
})

describe('V9: the what-if keep rule, as stored and as Generate describes it', () => {
  test('the same what-if replaces itself; at most 8 options, the plan\'s own kept before earlier what-ifs; a Generate without keep keeps none', async () => {
    const created = await real.create('train-a-work-week')
    const generate = async (input: object) => {
      const answer = await real.call('planning.plan.generate', { resource: created.id, input: { ...input, seconds: 1 }, expectedRevision: 1 })
      expect(answer.status).toBe(200)
      return (await real.store.read(real.workspaceId, created.id)).options!.options
    }
    const own = (await generate({})).map(option => option.key)
    expect(own).toHaveLength(2)
    const ask = (hours: number) => generate({ variants: [{ label: `At most ${hours} h out`, also: [also(hours)] }], keep: true })
    for (const hours of [40, 41, 42, 43, 44, 45]) await ask(hours)
    const full = await ask(45)
    // Asked again, the 45 h what-if replaced itself: still 8, the plan's own and six cards.
    expect([full.length, full.filter(option => option.variant.also !== undefined).length, own.every(key => full.some(option => option.key === key))]).toEqual([8, 6, true])
    // A seventh what-if: the plan's own stay; one earlier what-if makes room, and the read shows which.
    const after = await ask(46)
    const gone = full.filter(option => !after.some(entry => entry.key === option.key))
    expect([after.length, own.every(key => after.some(option => option.key === key)), gone.length, gone.every(option => option.variant.also !== undefined)]).toEqual([8, true, 1, true])
    expect(after.some(option => option.label === 'At most 46 h out')).toBe(true)
    // A Generate without keep: no what-if is kept.
    expect((await generate({})).some(option => option.variant.also !== undefined)).toBe(false)
  }, 120_000)

  test('Generate\'s description states the rule', async () => {
    const capabilities = (await real.request(`/internal/workspaces/${real.workspaceId}/capabilities`)).body.capabilities as Array<{ id: string; description: string }>
    const description = capabilities.find(entry => entry.id === 'planning.plan.generate')!.description
    expect(description).toContain('the same what-if replaces itself')
    expect(description).toContain('at most 8 options')
    expect(description).toContain('without keep none stay')
  })
})

describe('V11: "N options no longer match the plan" counts the plan\'s own options, by the card\'s rule', () => {
  test('a stale what-if card is not counted, as the Workspace card does not count it', async () => {
    const card = optionSchema.parse({ ...rebuild, key: 'at-48', label: 'At most 48 h out', inputsRevision: 2, variant: { ...rebuild.variant, also: [also(48)] } })
    const plan = await double.store.create(double.workspaceId, planWith(double.workspaceId, [variantOf(swap, { revision: 2 }), variantOf(rebuild, { revision: 2 }), card]))
    const attention = (await double.call('planning.plan.read', { resource: plan.id, input: {} })).body.result.sections[0].data.attention as Array<{ text: string }>
    expect(attention.map(item => item.text)).toContain('2 options no longer match the plan; generate again.')
    expect(summarize(plan).optionCount).toBe(2)
  })
})

