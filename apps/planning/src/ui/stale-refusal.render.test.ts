// Re-walk N4, found again on production on 19 Nov (coordinator/live-check-inc2-2026-11-19.md): after an estimate
// edit, a refused plan option made before the change was re-worded from its bare cause ("The times cannot line up
// along this chain: … (held by an outage limit)") instead of keeping its stored words ("The shortest span this
// plan allows is 80.5 h, against 72 h"). On a real refusal, solved and stored in the Module and read back through
// the screen's own load (plan-actions.ts) on the Module's API.
import { afterAll, describe, expect, test } from 'bun:test'
import { staleRefusalPreface } from '../api/contract.ts'
import { planWith, trainAInputs } from '../api/fixtures/choose.ts'
import { createHarness } from '../api/fixtures/harness.ts'
import { createRealSolver } from '../api/wiring.ts'
import { generate, type GenerateDeps } from '../solve/generate.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound, laneKVerifySpan } from '../solve/fixtures/lane-k.ts'
import { createSolverPool } from '../solve/pool.ts'
import { searchEngine } from '../solve/search.ts'
import { moduleClient } from './fixtures/module-client.ts'
import { createTimeFormat } from './format.ts'
import { createNames, planOptions } from './model.ts'
import { shortCause } from './outcome.ts'
import { createPlanActions } from './plan-actions.ts'
import type { Context } from './status-text.ts'

const pool = createSolverPool()
const harness = await createHarness({ solver: createRealSolver(pool) })
afterAll(async () => { await pool.shutdown(); await harness.close() })
const client = moduleClient(harness)

const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, verifySpan: laneKVerifySpan }
const context: Context = { inputs: trainAInputs, names: createNames(trainAInputs), format: createTimeFormat(trainAInputs.settings.timeZone) }
// The ladder's lowest rung for the swap, a plain option of the plan's own: days only, no bought crew time.
const swap = [{ choice: 'SWA-method', option: 'swap' }]
const [daysOnly] = (await generate(deps, { inputs: trainAInputs, revision: 3, previous: null, input: { variants: [{ label: 'Swap in refurbished spare: days only', methods: swap, buy: 'none' }] }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options
if (daysOnly?.status.word !== 'proven infeasible' || daysOnly.status.span === undefined) throw new Error('lane S refuses the swap on days only with a stored span')

const stored = await harness.store.create(harness.workspaceId, planWith(harness.workspaceId, [daysOnly]))
const actions = createPlanActions(client, stored.id)

describe('a refused option made before the latest change keeps its stored words (re-walk N4)', () => {
  test('the options table says the same refusal before and after an estimate edit, never re-worded from its cause', async () => {
    const before = (await actions.load(null)).model
    const fresh = planOptions(before).find(option => option.key === daysOnly.key)!
    expect(fresh.fresh).toBe(true)
    const words = shortCause(fresh, before, context)
    expect(words).toMatch(/80\.5 h, against 72 h/)

    const seal = trainAInputs.jobs.find(job => job.title === 'Replace CCW A mechanical seal')!
    await client.edit(stored.id, before.revision, { edits: [{ edit: 'job', key: seal.key, duration: { value: 14, unit: 'h' } }] })
    const after = (await actions.load(null)).model
    const stale = planOptions(after).find(option => option.key === daysOnly.key)!
    expect(stale.fresh).toBe(false)
    expect(shortCause(stale, after, context)).toBe(words)
    expect(shortCause(stale, after, context)).not.toContain('cannot line up')
    // The row already says it is out of date: the Module's preface is not repeated as the refusal's words.
    expect(after.refusals[daysOnly.key]![0]).not.toBe(staleRefusalPreface)
  }, 60_000)
})
