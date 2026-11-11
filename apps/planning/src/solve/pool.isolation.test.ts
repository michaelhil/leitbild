import { describe, expect, test } from 'bun:test'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { generate } from './generate.ts'
import { createSolverPool } from './pool.ts'
import { laneKCheck, laneKVerify } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import twinJson from './fixtures/twin-v3.json'

// Every solve on a pool is independent (lane P's defect report): flagship, V1, V2, twin v3 and the flagship
// again on ONE pool give exactly what each gives on a fresh pool. Evaluation budgets make the runs
// reproducible; the memory guard is set out of the way of the test runner's own memory.
const flagship = trainAInputs({ read: true })
const twin = twinPlan(twinJson, twinV3Options(twinJson))
const requests = [
  { name: 'flagship', inputs: flagship, input: { seconds: 20 }, evals: 1_500 },
  { name: 'V1', inputs: flagship, input: { variants: [{ label: 'V1', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' as const }], seconds: 20 }, evals: 1_500 },
  { name: 'V2', inputs: flagship, input: { variants: [{ label: 'V2', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'no-extra-crew-hours' as const }], seconds: 20 }, evals: 1_500 },
  { name: 'twin', inputs: twin.inputs, input: { variants: [{ label: 'twin', methods: [...twin.variant.methods], buy: [...twin.variant.purchases] }], seconds: 20 }, evals: 600 },
  { name: 'flagship again', inputs: flagship, input: { seconds: 20 }, evals: 1_500 },
]
const summary = (result: Awaited<ReturnType<typeof generate>>) => result.optionSet.options.map(option => ({
  key: option.key, word: option.status.word, purchases: option.variant.purchases, metrics: option.metrics,
  rows: option.rows.map(row => [row.job, row.start, row.finish, row.uses.map(use => `${use.resource}${use.purchase === undefined ? '' : `+${use.purchase}`}`).join(',')]),
  ...(option.status.word === 'proven infeasible' ? { cause: option.status.cause } : {}),
}))
const run = (pool: ReturnType<typeof createSolverPool>, request: (typeof requests)[number]) =>
  generate({ engine: pool, check: laneKCheck, verify: laneKVerify }, { inputs: request.inputs, revision: 1, previous: null, input: request.input, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: request.evals })

describe('solves on one pool are independent', () => {
  test('flagship, V1, V2, twin v3, flagship on one pool equal each run alone', async () => {
    const alone = []
    for (const request of requests) alone.push(summary(await run(createSolverPool({ rssLimitMb: 4_000 }), request)))
    const shared = createSolverPool({ rssLimitMb: 4_000 })
    const together = []
    for (const request of requests) together.push(summary(await run(shared, request)))
    for (const [index, request] of requests.entries()) expect({ name: request.name, result: together[index] }).toEqual({ name: request.name, result: alone[index] })
    expect(together[0]).toEqual(together[4])
    // The twin compiles through the product path and every flagship option is a checked plan.
    expect(together[3]![0]!.word).not.toBe('unsupported feature')
    expect(together[0]!.map(option => option.word)).toEqual(['validated feasible', 'validated feasible'])
  }, 300_000)
})
