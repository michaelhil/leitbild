import { afterAll, describe, expect, test } from 'bun:test'
import { createRealSolver } from '../api/wiring.ts'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { bounds } from './bounds.ts'
import { compile } from './compile.ts'
import { generate } from './generate.ts'
import { oneMoreUnit } from './limiting.ts'
import { createSolverPool } from './pool.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Walk 4, lane S items, on small plans written for the test (two jobs, one or two crews, one goal):
// R4-1 the hours one more unit of the limiting crew would gain; R4-3 a bound that counts a keep-free rule.
const planner = { by: 'planner' as const }
const job = (key: string, crews: readonly string[]) => ({
  key, title: `Deliver ${key}`, kind: 'work' as const, equipment: [], isolation: 'none' as const,
  duration: { value: 1, unit: 'h' as const, calendar: 'working' as const, origin: planner }, durationWith: [],
  needs: [{ anyOf: [...crews], amount: 1, handover: false }], continuous: true, checks: [], tags: [],
})
const crew = (key: string) => ({ key, label: `Truck ${key}`, kind: 'crew' as const, count: 1, calendar: 'always', attributes: [], source: planner })
const plan = (crews: readonly string[], rules: PlanInputs['rules'], jobCrews: readonly string[]): PlanInputs => planInputsSchema.parse({
  settings: { title: 'Two deliveries', timeZone: 'Europe/Oslo', window: { start: '2026-09-03T08:00:00Z', end: '2026-09-03T14:00:00Z' }, dataDate: null, grid: '30min', currency: 'NOK', run: null },
  equipment: [], groups: [],
  calendars: [{ key: 'always', label: 'Always', weekly: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner }],
  resources: crews.map(crew), purchases: [], methods: [], links: [], rules,
  jobs: [job('north', jobCrews), job('south', jobCrews)],
  goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }], world: { refreshedAt: null, facts: [] },
})
const by = { kind: 'service' as const, name: 'test' }
const optionOf = async (inputs: PlanInputs) => {
  const result = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, evals: 200 })
  const option = result.optionSet.options[0]!
  expect(option.status.word).toBe('validated feasible')
  return option
}
const lastFinish = (rows: ReadonlyArray<{ readonly finish: string }>) => Math.max(...rows.map(row => Date.parse(row.finish)))

describe('walk 4: the limiting crew in hours, and a bound that counts a keep-free rule', () => {
  const pool = createSolverPool()
  afterAll(() => pool.shutdown())

  test('R4-1: one more truck would allow a finish at least 1 h earlier, said only when lane K passes that plan', async () => {
    // One truck does both deliveries in turn: 2 h. With a second, the option's own order decoded again runs them together.
    const inputs = plan(['a'], [], ['a'])
    const option = await optionOf(inputs)
    expect((lastFinish(option.rows) - Date.parse(inputs.settings.window!.start)) / 3_600_000).toBe(2)
    const answer = await createRealSolver(pool).explain({ inputs, option, ask: 'finish', job: undefined, cursor: undefined })
    expect(answer.limiting).toEqual({ about: { kind: 'resource', key: 'a' }, hoursEarlier: 1 })
    // oneMoreUnit gives hours only for a decoded plan lane K's checker passes, on inputs with the extra truck.
    expect(oneMoreUnit(inputs, option, 'a')).toBe(1)
    // Nothing sound to say: on the flagship one more unit of any crew gains nothing in the option's own order.
    const flagship = trainAInputs({ read: true })
    const flagshipOption = (await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs: flagship, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, seed: 1, evals: 1_500 })).optionSet.options[0]!
    for (const resource of ['work-control', 'test-team']) expect(oneMoreUnit(flagship, flagshipOption, resource)).toBeUndefined()
    const flagshipAnswer = await createRealSolver(pool).explain({ inputs: flagship, option: flagshipOption, ask: 'finish', job: undefined, cursor: undefined })
    expect(flagshipAnswer.limiting).toBeUndefined()
  }, 120_000)

  test('R4-3: with two trucks and "keep one free" the deliveries go in turn; the finish bound counts the rule', async () => {
    const keepOneFree: PlanInputs['rules'] = [{ kind: 'keep-in-service', key: 'one-free', members: [{ resource: 'a' }, { resource: 'b' }], atLeast: 1, words: 'Keep one truck free at all times', source: planner }]
    const inputs = plan(['a', 'b'], keepOneFree, ['a', 'b'])
    const compiled = compile(inputs, { methods: [], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    const bound = bounds(compiled.problem, compiled.index).goals[0]!
    // Logic and calendars alone allow 1 h; the rule lends one truck at a time, so 2 h.
    expect(bound).toMatchObject({ value: 2, source: 'availability-rule', certificate: { kind: 'kept-free', rule: 'one-free', resources: ['a', 'b'], requiredHours: 2 } })
    const option = await optionOf(inputs)
    expect((lastFinish(option.rows) - Date.parse(inputs.settings.window!.start)) / 3_600_000).toBe(2)
    // One word for the goal, and never a weak bound beside it: proven when lane K re-derives 2 h; otherwise best
    // found with no bound (lane K's own bound did not reach it), never "best found" against a 1 h bound.
    const goal = option.status.word === 'validated feasible' ? option.status.goals[0]! : undefined
    expect(goal === undefined || goal.word === 'proven optimal' || goal.bound === undefined || goal.bound.value === goal.value).toBe(true)
  }, 120_000)
})
