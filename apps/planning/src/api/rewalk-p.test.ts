// Lane P's part of the re-walk fixes N2 and N4 (impl/inc23/batch2-rewalk-fixes.md): a refusal's hours come from
// the status as stored, proven in the solver child (lane S's `span`), so a read words them with no checker,
// compile or bounds, and an out-of-date refusal keeps its words exactly, marked as the earlier plan's.
import { afterAll, describe, expect, test } from 'bun:test'
import { generate, type GenerateDeps } from '../solve/generate.ts'
import { createSolverPool } from '../solve/pool.ts'
import { searchEngine } from '../solve/search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound, laneKVerifySpan } from '../solve/fixtures/lane-k.ts'
import { ladderRungs, rungRequest } from '../solve/ladder.ts'
import { planWith, trainAInputs, type Option } from './fixtures/choose.ts'
import { createHarness } from './fixtures/harness.ts'
import { createRealSolver } from './wiring.ts'

const pool = createSolverPool()
const real = await createHarness({ solver: createRealSolver(pool) })
afterAll(async () => { await pool.shutdown(); await real.close() })

// Generate as the solver child does, lane K proving each span refusal there (verifySpan), on the Train A inputs.
const proving: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, verifySpan: laneKVerifySpan }
const generated = async (input: Parameters<typeof generate>[1]['input']): Promise<Option[]> =>
  (await generate(proving, { inputs: trainAInputs, revision: 3, previous: null, input, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options
const methodLabel = (key: string) => trainAInputs.methods[0]!.options.find(entry => entry.key === key)!.label

describe('N4: after the 30 h estimate an out-of-date refusal keeps its stored words', () => {
  test('the ladder\'s span refusals, against 72 h: the same words before and after the edit, marked as the earlier plan\'s', async () => {
    // The walk's ladder: rungs 0 and 1 as the screen asks them; the refusals held by the 72 h rule store their span.
    const rungs = ladderRungs(trainAInputs).slice(0, 2)
    const options = (await Promise.all(rungs.map(rung => generated(rungRequest(trainAInputs, rung, combo => `${methodLabel(combo[0]!.option)}: rung ${rung.rung + 1}`))))).flat()
    const refused = options.filter(option => option.status.word === 'proven infeasible' && option.status.span !== undefined)
    const spans = refused.map(option => option.status.word === 'proven infeasible' ? option.status.span : undefined)
    // The walk's two: Swap at rung 0 and Rebuild at rung 1, each out at least some hours against the 72 h rule.
    expect(spans.map(span => span!.limitHours)).toEqual([72, 72])
    const plan = await real.store.create(real.workspaceId, planWith(real.workspaceId, refused))
    const explain = async (option: Option) => {
      const answer = await real.call('planning.plan.explain', { resource: plan.id, input: { ask: 'refusal', option: option.key } })
      expect(answer.status).toBe(200)
      return answer.body.result.lines as string[]
    }
    const before = await Promise.all(refused.map(explain))
    before.forEach((lines, index) => expect(lines.join(' ')).toContain(`${spans[index]!.leastHours} h, against ${spans[index]!.limitHours} h`))
    console.log('N4 before:', before.map(lines => lines[1]).join(' | '))
    // The walk's 30 h estimate on the rebuild: a new revision, no search run.
    const job = trainAInputs.jobs.find(entry => entry.title === 'Rebuild SW A bowl assembly in workshop')!
    expect((await real.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'job', key: job.key, duration: { value: 30, unit: 'h' } }] }, expectedRevision: plan.revision })).status).toBe(200)
    const after = await Promise.all(refused.map(explain))
    after.forEach((lines, index) => {
      expect(lines[0]).toBe('On the plan before your latest change: generate again to know for the plan as it is now.')
      expect(lines.slice(1)).toEqual(before[index]!.slice(0, lines.length - 1))
    })
  }, 120_000)
})

describe('N2: a refused what-if gives each method\'s least outage against the hours asked', () => {
  test('at most 40 h out: "<method>: out at least N h, against the 40 h asked" for each method, from the stored spans', async () => {
    const at40 = { kind: 'span-limit' as const, key: 'what-if-COOL-A-40h', group: 'COOL-A', limit: { value: 40, unit: 'h' as const }, singleEntry: true, words: 'Train A cooling chain back within 40 h', source: { by: 'planner' as const } }
    const [what] = await generated({ variants: [{ label: 'At most 40 h out', also: [at40] }] })
    if (what?.status.word !== 'proven infeasible' || what.status.byMethod === undefined) throw new Error('the 40 h what-if is refused for every method')
    const plan = await real.store.create(real.workspaceId, planWith(real.workspaceId, [what]))
    const lines: string[] = (await real.call('planning.plan.explain', { resource: plan.id, input: { ask: 'refusal', option: what.key } })).body.result.lines
    console.log('N2:', lines.slice(0, 4).join(' | '))
    for (const entry of what.status.byMethod) {
      expect(entry.span).toBeDefined()
      expect(lines).toContain(`${methodLabel(entry.methods[0]!.option)}: out at least ${entry.span!.leastHours} h, against the 40 h asked.`)
    }
    expect(lines.join(' ')).not.toContain(at40.key)
  }, 120_000)
})
