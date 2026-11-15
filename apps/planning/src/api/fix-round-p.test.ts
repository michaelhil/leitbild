// Lane P's batch 2 fix round (impl/inc23/batch2-fix-round.md; adversary inc2-server-review findings 5 and 6, and
// the banner side of U1), through the operations on stored plans.
import { afterAll, describe, expect, test } from 'bun:test'
import { sectionDataSchemas } from './contract.ts'
import { createSolverDouble } from './fixtures/doubles.ts'
import { formulation, found, planWith, provenOn, rebuild, refused, refusedWith, swap, trainAInputs, variantOf, type Option } from './fixtures/choose.ts'
import { createHarness } from './fixtures/harness.ts'
import { rungsOf } from '../plan/buys.ts'
import { optionSchema } from '../plan/schema.ts'

const harness = await createHarness({ solver: { ...createSolverDouble(), formulation: () => formulation } })
afterAll(() => harness.close())
const read = async (id: string, section: 'previous' | 'options') => {
  const pages = []
  let cursor: string | undefined
  do {
    const data = sectionDataSchemas[section].parse((await harness.call('planning.plan.read', { resource: id, input: { section, ...(cursor === undefined ? {} : { cursor }) } })).body.result.sections[0].data)
    pages.push(data)
    cursor = data.more
  } while (cursor !== undefined)
  return pages.flatMap(data => data.items)
}
/** A what-if solved with the extra-cost goal first, validated feasible: a card, never ranked. */
const leadCard = (): Option => optionSchema.parse({
  ...rebuild, key: 'cheapest', label: 'Cheapest that keeps every rule',
  variant: { ...rebuild.variant, lead: { goal: 1 } }, status: { ...provenOn(rebuild, 1), lead: { goal: 1 } },
})

describe('F5: the previous set\'s dominance is worked out only on the goals it was made with', () => {
  // "Rebuild, later": one more hour out of service than Rebuild, so Rebuild dominates it on these goals.
  const later = variantOf(rebuild, { key: 'rebuild-later', label: 'Rebuild, later', revision: 2, metrics: rebuild.metrics.map(metric => metric.id === 'goal:2' ? { ...metric, value: metric.value + 1 } : metric) })
  const previous = (plan: ReturnType<typeof planWith>) => ({ at: plan.options!.at, by: { kind: 'human' as const }, options: [variantOf(rebuild, { revision: 2 }), later] })

  test('goals unchanged since: dominance shown; the goals changed, or the history no longer says: none', async () => {
    const base = planWith(harness.workspaceId, [swap, rebuild])
    const same = await harness.store.create(harness.workspaceId, { ...base, previousOptions: previous(base) })
    expect((await read(same.id, 'previous')).map(item => item.dominated?.by ?? null)).toEqual([null, rebuild.key])
    const reordered = planWith(harness.workspaceId, [swap, rebuild])
    const changed = await harness.store.create(harness.workspaceId, { ...reordered, previousOptions: previous(reordered), changes: reordered.changes.map(change => change.revision === 3 ? { ...change, kinds: ['goals' as const], summary: 'Changed the goal order' } : change) })
    expect((await read(changed.id, 'previous')).map(item => item.dominated?.by ?? null)).toEqual([null, null])
    const trimmed = planWith(harness.workspaceId, [swap, rebuild])
    const unknown = await harness.store.create(harness.workspaceId, { ...trimmed, previousOptions: previous(trimmed), changes: trimmed.changes.filter(change => change.revision !== 3), droppedChanges: 1 })
    expect((await read(unknown.id, 'previous')).map(item => item.dominated?.by ?? null)).toEqual([null, null])
  })
})

describe('F6: no ranked option feasible is said as that, beside a feasible what-if card', () => {
  test('explain recommended says "no ranked option is validated feasible", never "none"', async () => {
    const plan = await harness.store.create(harness.workspaceId, planWith(harness.workspaceId, [refusedWith(swap, rungsOf(trainAInputs)[0]!.buy), leadCard()]))
    const answer = await harness.call('planning.plan.explain', { resource: plan.id, input: { ask: 'recommended' } })
    expect(answer.body.result.lines).toEqual(['No option is recommended: no ranked option is validated feasible.'])
  })

  test('the Generate sentence says the same when only a lead what-if is feasible', async () => {
    const inner = createSolverDouble()
    const local = await createHarness({ solver: { ...inner, formulation: () => formulation, generate: async request => ({ at: request.at, by: request.by, options: [variantOf(swap, { revision: request.inputsRevision, status: refused() }), variantOf(leadCard(), { revision: request.inputsRevision })] }) } })
    try {
      const created = await local.create('train-a-work-week')
      const answer = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      expect([answer.status, answer.body.result.text]).toEqual([200, 'No option can be recommended: no ranked option is validated feasible.'])
    } finally { await local.close() }
  })
})

describe('U1, the banner side: the Generate sentence names the recommended option\'s method, never its rung label', () => {
  test('a rung option recommended: its method, then its status and what it buys', async () => {
    const inner = createSolverDouble()
    const daysOnly = (revision: number) => variantOf(swap, { revision, label: 'Swap in refurbished spare: days only', status: found(swap) })
    const local = await createHarness({ solver: { ...inner, formulation: () => formulation, generate: async request => ({ at: request.at, by: request.by, options: [daysOnly(request.inputsRevision)], recommended: swap.key }) } })
    try {
      const created = await local.create('train-a-work-week')
      const text: string = (await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })).body.result.text
      expect(text).toStartWith('Swap in refurbished spare: Validated feasible')
      expect(text).not.toContain('days only')
    } finally { await local.close() }
  })
})
