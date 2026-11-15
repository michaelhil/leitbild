// A what-if's one extra hard rule (design §4.2, §8 "Extra rule"): appended to the plan's rules for compile
// and lane K's check, never replacing one; the option keeps it, or is honestly refused. Times come from the
// fixture's rules and checked runs, never typed.
import { describe, expect, test } from 'bun:test'
import { checkPlan } from '../check/check.ts'
import { generate, optionKey, solveInputsOf, type AlsoRule, type GenerateDeps } from './generate.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
const flagship = trainAInputs({ read: true })
const swap = [{ choice: 'SWA-method', option: 'swap' }]
const run = (variants: NonNullable<Parameters<typeof generate>[1]['input']['variants']>) =>
  generate(deps, { inputs: flagship, revision: 1, previous: null, input: { variants }, by, signal: new AbortController().signal, seed: 1, evals: 600 })
const coolLimit = flagship.rules.find(rule => rule.kind === 'span-limit' && rule.group === 'COOL-A')!
if (coolLimit.kind !== 'span-limit') throw new Error('The flagship limits the COOL-A span')
/** "At most N h out" for COOL-A: the plan's own limit, shorter by `less` h. */
const shorter = (less: number): Extract<AlsoRule, { kind: 'span-limit' }> => ({ kind: 'span-limit', key: 'W-COOL', group: 'COOL-A', limit: { value: coolLimit.limit.value - less, unit: coolLimit.limit.unit }, singleEntry: true, words: 'At most this long out', source: { by: 'planner' } })
const due = (job: string, finishBy: string): AlsoRule => ({ kind: 'due', key: 'W-DUE', job, finishBy, words: 'Back by then', source: { by: 'planner' } })

describe('the extra rule is added, never replacing one', () => {
  test('the rule is appended to the plan\'s rules; the plan keeps its own', () => {
    const { ruled, solving } = solveInputsOf(flagship, { also: [shorter(1)] })
    expect(ruled.rules).toEqual([...flagship.rules, shorter(1)])
    expect(solving.goals).toBe(flagship.goals)
    expect(flagship.rules.some(rule => rule.key === 'W-COOL')).toBe(false)
  })

  test('the same what-if asked again has the same key, whatever its label or rule key; another rule another key', () => {
    const first = optionKey(flagship, { methods: swap, buy: 'allowed', also: [shorter(1)] })
    expect(optionKey(flagship, { methods: swap, buy: 'allowed', also: [{ ...shorter(1), key: 'OTHER', words: 'Other words' }] })).toBe(first)
    expect(optionKey(flagship, { methods: swap, buy: 'allowed', also: [shorter(2)] })).not.toBe(first)
    expect(optionKey(flagship, { methods: swap, buy: 'allowed' })).toBe('swap')
    expect(first.length).toBeLessThanOrEqual(55)
  })
})

describe('an option keeps its extra rule, or is refused', () => {
  test('back by its own finish: kept; the plan\'s rules and the extra rule both hold on its rows', async () => {
    const plain = (await run([{ label: 'Swap', methods: swap }])).optionSet.options[0]!
    expect(plain.status.word).toBe('validated feasible')
    // The last COOL-A return-to-service test of the plain option, due by the time it finishes there.
    const tests = flagship.jobs.filter(job => job.kind === 'test' && job.equipment.some(item => flagship.equipment.find(entry => entry.key === item)?.group === 'COOL-A')).map(job => job.key)
    const last = plain.rows.filter(row => tests.includes(row.job)).toSorted((x, y) => Date.parse(y.finish) - Date.parse(x.finish))[0]!
    const rule = due(last.job, last.finish)
    const option = (await run([{ label: 'Back by then', methods: swap, also: [rule] }])).optionSet.options[0]!
    expect(option.variant.also).toEqual([rule])
    expect(option.status.word).toBe('validated feasible')
    expect(checkPlan({ ...flagship, rules: [...flagship.rules, rule] }, option.variant, option.rows).violations).toEqual([])
    expect(checkPlan(flagship, option.variant, option.rows).violations).toEqual([])
    expect(Date.parse(option.rows.find(row => row.job === last.job)!.finish)).toBeLessThanOrEqual(Date.parse(last.finish))
  }, 60_000)

  test('back before the window has room for the work: never validated feasible', async () => {
    const window = flagship.settings.window!
    const lastTest = flagship.jobs.filter(job => job.kind === 'test').at(-1)!
    const option = (await run([{ label: 'Back at once', methods: swap, also: [due(lastTest.key, new Date(Date.parse(window.start) + 3_600_000).toISOString())] }])).optionSet.options[0]!
    expect(option.status.word).not.toBe('validated feasible')
    if (option.status.word === 'proven infeasible') expect(laneKVerify({ ...flagship, rules: [...flagship.rules, ...option.variant.also!] }, option.variant, option.status.cause).proves).toBe(true)
  }, 60_000)

  test('"at most an hour less out" for COOL-A: a shorter legal plan within the shorter limit, or an honest refusal', async () => {
    const rule = shorter(1)
    const option = (await run([{ label: 'At most an hour less out', methods: swap, also: [rule] }])).optionSet.options[0]!
    expect(option.variant.also).toEqual([rule])
    if (option.status.word === 'validated feasible') {
      const own = checkPlan({ ...flagship, rules: [...flagship.rules, rule] }, option.variant, option.rows)
      expect(own.violations).toEqual([])
      expect(own.metrics.find(entry => entry.id === 'span:COOL-A')!.value).toBeLessThanOrEqual(rule.limit.value)
    } else {
      expect(['proven infeasible', 'unresolved']).toContain(option.status.word)
    }
  }, 60_000)
})
