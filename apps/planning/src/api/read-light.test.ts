// No checker on a read (coordinator, lane P batch 2, decision 2): the service stays light, and lane K's
// checker runs in the solver child at Generate time. read buys, explain recommended and explain versus
// answer from stored figures only. This file counts lane K's checkPlan calls made during those reads on the
// real wiring. read buys fails it until lane K's rungStanding over stored data lands and the service uses it.
import { afterAll, expect, mock, test } from 'bun:test'
import * as check from '../check/check.ts'

const original = check.checkPlan
let checks = 0
mock.module('../check/check.ts', () => ({ ...check, checkPlan: (...args: Parameters<typeof original>) => { checks += 1; return original(...args) } }))

const { createSolverPool } = await import('../solve/pool.ts')
const { createRealSolver } = await import('./wiring.ts')
const { createHarness } = await import('./fixtures/harness.ts')
const { planWith, rebuild, refusedWith, setAt, swap, trainAInputs, variantOf } = await import('./fixtures/choose.ts')
const { rungsOf } = await import('../plan/buys.ts')

const pool = createSolverPool()
const solver = createRealSolver(pool)
const harness = await createHarness({ solver })
afterAll(async () => { await pool.shutdown(); await harness.close() })

/** Checker calls made while `read` runs. */
const counted = async (read: () => Promise<{ status: number }>): Promise<[number, number]> => {
  const before = checks
  const answer = await read()
  return [answer.status, checks - before]
}

test('read buys, why recommended and versus run no checker in the service', async () => {
  // Each rung's option under the key Generate gives its buy list: days only refused, Rebuild, Swap.
  const rungs = rungsOf(trainAInputs)
  const keyOf = (rung: number) => `${solver.variantKey(trainAInputs, { buy: [...rungs[rung]!.buy] })}.0a1b2c3d`
  const options = [refusedWith(variantOf(rebuild, { key: keyOf(0) }), rungs[0]!.buy), variantOf(rebuild, { key: keyOf(1) }), variantOf(swap, { key: keyOf(2) })]
  const plan = await harness.store.create(harness.workspaceId, planWith(harness.workspaceId, options, 3, { previousOptions: { at: setAt, by: { kind: 'human' }, options: [variantOf(swap, { revision: 2 })] } }))
  const read = (input: object) => () => harness.call('planning.plan.read', { resource: plan.id, input })
  const explain = (input: object) => () => harness.call('planning.plan.explain', { resource: plan.id, input })
  expect(await counted(explain({ ask: 'recommended' }))).toEqual([200, 0])
  expect(await counted(explain({ ask: 'versus', versus: { previous: swap.key } }))).toEqual([200, 0])
  expect(await counted(read({ section: 'options' }))).toEqual([200, 0])
  expect(await counted(read({ section: 'buys' }))).toEqual([200, 0])
}, 60_000)
