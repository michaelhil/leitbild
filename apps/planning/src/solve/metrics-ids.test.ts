// The goal figures an option stores are named by the plan's goal ids and, for a span-over goal, by the
// checker's own group keys, never by position (fix round F4). A plan without an extra-cost goal stores the
// checker's extra cost, which the ladder compares (fix round, small item).
import { describe, expect, test } from 'bun:test'
import { checkPlan } from '../check/check.ts'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { generate, type GenerateDeps } from './generate.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
const flagship = trainAInputs({ read: true })
const swap = [{ choice: 'SWA-method', option: 'swap' }]
const solve = async (inputs: PlanInputs) => (await generate(deps, { inputs, revision: 1, previous: null, input: { variants: [{ label: 'Swap', methods: swap }] }, by, signal: new AbortController().signal, seed: 1, evals: 300 })).optionSet.options[0]!

describe('span figures by group key (F4)', () => {
  test('a span-over goal over every group, one group never out and listed first: each figure on its own group', async () => {
    // A group with a span rule but no equipment: compile lists it first among the span rules' groups; the
    // checker lists only the groups that are out.
    const idle = { key: 'IDLE', label: 'A group nothing takes out' }
    const inputs = planInputsSchema.parse({
      ...flagship, groups: [...flagship.groups, idle],
      rules: [{ kind: 'span-limit', key: 'R-IDLE', group: idle.key, limit: { value: 72, unit: 'h' }, singleEntry: true, words: 'Back within 72 h', source: { by: 'planner' } }, ...flagship.rules],
      goals: [{ metric: 'span-over', threshold: { value: 54, unit: 'h' }, tolerance: { value: 0, unit: 'h' } }],
    })
    const option = await solve(inputs)
    expect(option.status.word).toBe('validated feasible')
    const own = checkPlan(inputs, option.variant, option.rows).metrics.filter(metric => metric.id.startsWith('span:'))
    expect(own.length).toBeGreaterThan(1)
    expect(option.metrics.filter(metric => metric.id.startsWith('goal:0:')).map(metric => [metric.id.slice('goal:0:'.length), metric.value]).toSorted())
      .toEqual(own.map(metric => [metric.id.slice('span:'.length), metric.value]).toSorted())
  }, 60_000)
})

describe('the extra cost without an extra-cost goal', () => {
  test('stored as the checker\'s own extra-cost figure', async () => {
    const inputs = planInputsSchema.parse({ ...flagship, goals: flagship.goals.filter(goal => goal.metric !== 'extra-cost') })
    const option = await solve(inputs)
    expect(option.status.word).toBe('validated feasible')
    const own = checkPlan(inputs, option.variant, option.rows).metrics.find(metric => metric.id === 'extra-cost')!
    expect(option.metrics.find(metric => metric.id === 'extra-cost')).toEqual(own)
    // With an extra-cost goal the cost is that goal's figure, stored once.
    expect((await solve(flagship)).metrics.some(metric => metric.id === 'extra-cost')).toBe(false)
  }, 60_000)
})

describe('each ruled group\'s span, for the comparison and the outage floor', () => {
  test('Train A: every group with a span rule stores lane K\'s span:<group>, not only the goal\'s group', async () => {
    const option = await solve(flagship)
    const ruled = [...new Set(flagship.rules.flatMap(rule => (rule.kind === 'span-limit' ? [rule.group] : [])))]
    expect(ruled.length).toBe(3)
    const own = checkPlan(flagship, option.variant, option.rows).metrics
    for (const group of ruled) expect(option.metrics.find(metric => metric.id === `span:${group}`)).toEqual(own.find(metric => metric.id === `span:${group}`))
    expect(option.metrics.filter(metric => metric.id.startsWith('span:')).length).toBe(3)
  }, 60_000)
})
