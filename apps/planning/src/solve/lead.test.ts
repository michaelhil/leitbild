// A what-if that solves a goal first (design §0.3, §4.2, §8 Adv 1 and part 2 D): the plan's goal ids stay,
// only the lead may be proven, metric ids are the plan's (fix D), and a lead what-if is never ranked or
// recommended. Expected figures are lane K's own on the option's rows, never typed.
import { describe, expect, test } from 'bun:test'
import { checkPlan } from '../check/check.ts'
import { optionSetSchema, planInputsSchema } from '../plan/schema.ts'
import { generate, groupLeadGoal, rawOf, solveInputsOf, type GenerateDeps } from './generate.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
const flagship = trainAInputs({ read: true })
const swap = [{ choice: 'SWA-method', option: 'swap' }]
const run = (variants: NonNullable<Parameters<typeof generate>[1]['input']['variants']>, extra: Partial<GenerateDeps> = {}) =>
  generate({ ...deps, ...extra }, { inputs: flagship, revision: 1, previous: null, input: { variants }, by, signal: new AbortController().signal, seed: 1, evals: 600 })
const metric = (option: { readonly metrics: ReadonlyArray<{ readonly id: string; readonly value: number }> }, id: string) => option.metrics.find(entry => entry.id === id)?.value

describe('the goal list a lead is solved with', () => {
  test('a group lead heads the plan\'s goals; a goal lead moves that goal first; positions map back to the plan\'s ids', () => {
    const group = solveInputsOf(flagship, { lead: { group: 'AFW-A' } })
    expect(group.solving.goals).toEqual([groupLeadGoal('AFW-A'), ...flagship.goals])
    expect([0, 1, 2, 3].map(group.planGoalOf)).toEqual([undefined, 0, 1, 2])
    const cost = solveInputsOf(flagship, { lead: { goal: 1 } })
    expect(cost.solving.goals).toEqual([1, 0, 2].map(k => flagship.goals[k]!))
    expect([0, 1, 2].map(cost.planGoalOf)).toEqual([1, 0, 2])
    // The plan's own goals and rules are not changed.
    expect(group.ruled).toBe(flagship)
  })
})

describe('"Finish AFW A first": lead {group}', () => {
  test('fix D: "Longest outage" and "Extra cost" stay on their own figures; the lead is lane K\'s span of AFW A', async () => {
    const result = await run([{ label: 'Finish AFW A first', methods: swap, lead: { group: 'AFW-A' } }])
    const option = result.optionSet.options[0]!
    expect(option.status.word).toBe('validated feasible')
    if (option.status.word !== 'validated feasible') return
    const own = checkPlan(flagship, option.variant, option.rows)
    expect(own.violations).toEqual([])
    // The plan's goals by their ids: goal 0 is COOL-A's span, goal 1 the extra cost, goal 2 the unavailable hours.
    const [span, cost, unavailable] = own.goals
    expect(span?.metric === 'span-over' && span.spans.map(entry => [`goal:0:${entry.group}`, entry.value])).toEqual(option.metrics.filter(entry => entry.id.startsWith('goal:0:')).map(entry => [entry.id, entry.value]))
    expect(metric(option, 'goal:1')).toBe(cost?.metric === 'extra-cost' ? cost.value : NaN)
    expect(metric(option, 'goal:2')).toBe(unavailable?.metric === 'unavailable-hours' ? unavailable.value : NaN)
    expect(option.metrics.some(entry => entry.id === 'goal:3' || entry.id.startsWith('goal:3:'))).toBe(false)
    // The lead's own line is the checker's AFW A span; goals keep the plan's ids and order, none proven.
    expect(option.status.lead).toMatchObject({ group: 'AFW-A', value: own.metrics.find(entry => entry.id === 'span:AFW-A')!.value, unit: 'h' })
    expect(option.status.goals.map(goal => [goal.goal, goal.word])).toEqual([[0, 'best found under budget'], [1, 'best found under budget'], [2, 'best found under budget']])
    expect(option.variant.lead).toEqual({ group: 'AFW-A' })
    expect(rawOf(option, flagship.goals.length).length).toBe(3)
  }, 60_000)

  test('the lead\'s proof is re-derived by lane K on the list it was solved with', async () => {
    const asked: unknown[] = []
    const recording: GenerateDeps['verifyBound'] = (inputs, variant, goal, bound) => { asked.push(goal); return laneKVerifyBound(inputs, variant, goal, bound) }
    const proven = await run([{ label: 'Finish AFW A first', methods: swap, lead: { group: 'AFW-A' } }], { verifyBound: recording })
    const lead = proven.optionSet.options[0]!.status
    const line = lead.word === 'validated feasible' ? lead.lead : undefined
    // Lane K re-derives a group lead on the group's own span, on the plan's inputs; a plan goal never proves here.
    if (line !== undefined && 'word' in line && line.word === 'proven optimal') expect(asked).toEqual([{ group: 'AFW-A', unit: 'h' }])
    // A bound lane K does not re-derive: the lead reads best found.
    const refused = await run([{ label: 'Finish AFW A first', methods: swap, lead: { group: 'AFW-A' } }], { verifyBound: () => ({ proves: false }) })
    const status = refused.optionSet.options[0]!.status
    expect(status.word === 'validated feasible' && status.lead).toMatchObject({ word: 'best found under budget', group: 'AFW-A' })
  }, 60_000)
})

describe('"Cheapest that keeps every rule": lead {goal: 1}', () => {
  test('only the cost goal may be proven; the what-if is a card, never recommended, and the plan does not change', async () => {
    const before = JSON.stringify(flagship)
    const result = await run([{ label: 'Swap', methods: swap }, { label: 'Cheapest that keeps every rule', methods: swap, lead: { goal: 1 } }])
    expect(JSON.stringify(flagship)).toBe(before)
    expect(optionSetSchema.safeParse(result.optionSet).success).toBe(true)
    const [plain, cheapest] = result.optionSet.options
    expect(cheapest!.variant.lead).toEqual({ goal: 1 })
    expect(plain!.variant.lead).toBeUndefined()
    expect(result.optionSet.recommended).toBe(plain!.key)
    expect(cheapest!.status.word).toBe('validated feasible')
    if (cheapest!.status.word !== 'validated feasible') return
    expect(cheapest!.status.lead).toEqual({ goal: 1 })
    expect(cheapest!.status.goals.map(goal => goal.goal)).toEqual([0, 1, 2])
    for (const goal of cheapest!.status.goals) if (goal.goal !== 1) expect(goal.word).toBe('best found under budget')
    // Its figures are the plan's goals on its own rows.
    const own = laneKCheck({ inputs: flagship, variant: cheapest!.variant, rows: cheapest!.rows })
    expect(own.violations).toEqual([])
    expect(metric(cheapest!, 'goal:1')).toBe(own.goals[1] as number)
  }, 60_000)

  test('a lead beyond the plan\'s goals is refused before any solve', () => {
    const three = planInputsSchema.parse(flagship)
    expect(() => solveInputsOf(three, { lead: { goal: 1 } })).not.toThrow()
    return expect(run([{ label: 'Goal 4 first', lead: { goal: 3 } }])).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })
})
