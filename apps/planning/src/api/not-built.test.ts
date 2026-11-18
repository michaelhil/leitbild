// Increment 2 inputs that the contract took before their lanes built them were refused with 501 not_built,
// never ignored (adversary review of lane A, R1). Every such refusal is now lifted with its implementation:
// lane S builds also, lead and keep (solve/whatif.test.ts, lead.test.ts, ladder.test.ts); lane P passes keep
// on to the solver and answers the explain asks recommended and versus itself, from stored options
// (api/operations.ts), so the solver's explain never sees them (api/wiring.ts). This file checks that none
// is refused any more, and that none is answered by something else.
import { afterAll, describe, expect, test } from 'bun:test'
import { isPlanningError } from '../errors.ts'
import { bundledPlanDefinitions } from '../definitions/index.ts'
import { variantsOf } from '../solve/generate.ts'
import { createSolverPool } from '../solve/pool.ts'
import { planWith, rebuild, setAt, swap } from './fixtures/choose.ts'
import { createHarness } from './fixtures/harness.ts'
import { createRealSolver } from './wiring.ts'

const pool = createSolverPool()
const real = await createHarness({ solver: createRealSolver(pool) })
afterAll(async () => { await pool.shutdown(); await real.close() })

const inputs = bundledPlanDefinitions.find(definition => definition.id === 'train-a-work-week')!.inputs
const rule = { kind: 'span-limit' as const, key: 'W48', group: 'COOL-A', limit: { value: 48, unit: 'h' as const }, singleEntry: true, words: 'Train A cooling chain back within 48 h', source: { by: 'planner' as const } }
const refusal = async (run: () => unknown): Promise<unknown> => {
  try { await run(); return 'answered' } catch (error) { return isPlanningError(error) ? [error.status, error.code, error.details] : error }
}

describe('Generate takes what it once refused', () => {
  test('the solver takes also, lead and keep: each what-if keeps what it asks', async () => {
    expect(variantsOf(inputs, { variants: [{ label: 'At most 48 h out', also: [rule] }] }).map(variant => [variant.label, variant.also])).toEqual([['At most 48 h out', [rule]]])
    expect(variantsOf(inputs, { variants: [{ label: 'Finish AFW A first', lead: { group: 'AFW-A' } }] }).map(variant => variant.lead)).toEqual([{ group: 'AFW-A' }])
    expect(variantsOf(inputs, { variants: [{ also: [rule] }, { lead: { goal: 1 } }], keep: true }).map(variant => [variant.also, variant.lead])).toEqual([[[rule], undefined], [undefined, { goal: 1 }]])
    expect(variantsOf(inputs, { variants: [{ label: 'Days only', buy: 'no-extra-crew-hours' }] }).map(variant => variant.label)).toEqual(['Days only'])
  })

  test('on the real solver, an "at most 48 h out" what-if is stored with its rule, never as an ordinary option', async () => {
    const created = await real.create('train-a-work-week')
    const answer = await real.call('planning.plan.generate', { resource: created.id, input: { variants: [{ label: 'At most 48 h out', also: [rule] }], seconds: 2 }, expectedRevision: created.revision })
    expect(answer.status).toBe(200)
    const stored = await real.store.read(real.workspaceId, created.id)
    expect(stored.options!.options.map(option => option.variant.also)).toEqual([[rule]])
  }, 60_000)

  test('the service passes keep on: the real solver adds the what-if to the options already there', async () => {
    const created = await real.create('train-a-work-week')
    const generate = (input: object) => real.call('planning.plan.generate', { resource: created.id, input: { ...input, seconds: 2 }, expectedRevision: created.revision })
    expect((await generate({ variants: [{ label: 'With purchases' }] })).status).toBe(200)
    const first = (await real.store.read(real.workspaceId, created.id)).options!.options.map(option => option.key)
    expect((await generate({ variants: [{ label: 'Days only', buy: 'no-extra-crew-hours' }], keep: true })).status).toBe(200)
    const kept = (await real.store.read(real.workspaceId, created.id)).options!.options
    expect([kept.length, first.every(key => kept.some(option => option.key === key))]).toEqual([first.length + 1, true])
  }, 60_000)
})

describe('why recommended and versus are the service\'s, never the solver\'s finish chain', () => {
  test('on the real solver, explain recommended and versus answer from stored options; the solver refuses any ask it does not answer', async () => {
    const plan = planWith(real.workspaceId, [swap, rebuild], 3, { previousOptions: { at: setAt, by: { kind: 'human' }, options: [{ ...swap, inputsRevision: 2 }] } })
    await real.store.create(real.workspaceId, plan)
    const why = await real.call('planning.plan.explain', { resource: plan.id, input: { ask: 'recommended' } })
    expect([why.status, why.body.result.items, why.body.result.lines[1]]).toEqual([200, [], `Next in rank: '${rebuild.label}'.`])
    const versus = await real.call('planning.plan.explain', { resource: plan.id, input: { ask: 'versus', option: rebuild.key, versus: { previous: swap.key } } })
    expect([versus.status, versus.body.result.items]).toEqual([200, []])
    expect(versus.body.result.lines[0]).toStartWith(`'${rebuild.label}' against '${swap.label}' of the previous options`)
    const solver = createRealSolver(pool)
    for (const ask of ['recommended', 'versus'] as const) {
      expect(await refusal(() => solver.explain({ inputs: plan.inputs, option: swap, ask: ask as never, job: undefined, cursor: undefined }))).toEqual([500, 'invalid_planning_request', undefined])
    }
    expect((await solver.explain({ inputs: plan.inputs, option: swap, ask: 'finish', job: undefined, cursor: undefined })).items.length).toBeGreaterThan(0)
  }, 60_000)
})
