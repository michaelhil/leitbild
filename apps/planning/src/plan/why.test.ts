// "Why recommended" (design §4.2, §7, T11): the plan's goal order in words, the goal that decided against the
// next option in rank, the trade in units, the unpriced caveats, and what is proven about the outage. Built
// from stored, checked options only. Options and expected figures come from increment 1's real Train A options.
import { describe, expect, test } from 'bun:test'
import { explainResultSchema } from '../api/contract.ts'
import { found, provenOn, rebuild, refused, swap, trainAInputs, variantOf, type Option } from '../api/fixtures/choose.ts'
import { valueWords } from './summary.ts'
import { whyRecommendedLines } from './why.ts'

const goal = (option: Option, k: number) => option.status.word === 'validated feasible' ? option.status.goals[k]!.value : NaN
const lines = (recommended: Option, others: readonly Option[], named?: Option) => whyRecommendedLines(trainAInputs, recommended, others, named)
const fits = (text: readonly string[]) => {
  expect(text.every(line => line.length <= 240)).toBe(true)
  expect(explainResultSchema.safeParse({ lines: text, items: [] }).success).toBe(true)
}

describe('why the recommended option ranks first', () => {
  test('the goal order in words, the deciding goal with both values, and the trade in units (T11)', () => {
    const text = lines(swap, [rebuild])
    fits(text)
    // The policy: every hard rule first, then the plan's goals in their order, each with its step.
    const policy = text[0]!
    expect(policy).toStartWith('Ranked by: every hard rule kept first, then outage time of Train A cooling chain')
    const at = ['over 54 h', 'then extra cost (in steps of NOK 25,000)', 'then hours out of service.'].map(part => policy.indexOf(part))
    expect(at.every((index, i) => index > 0 && (i === 0 || index > at[i - 1]!))).toBe(true)
    expect(text).toContain('Next in rank: \'Rebuild in place\'.')
    expect(text).toContain(`Decided on outage time over 54 h: ${valueWords(goal(swap, 0), 'h')} against ${valueWords(goal(rebuild, 0), 'h')}.`)
    // The trade: what the recommended option gains, for what it gives up, as differences in each goal's unit.
    const outage = goal(rebuild, 0) - goal(swap, 0), costMore = goal(swap, 1) - goal(rebuild, 1), outOfService = goal(rebuild, 2) - goal(swap, 2)
    expect([outage > 0, costMore > 0, outOfService > 0]).toEqual([true, true, true])
    expect(text).toContain(`The trade: ${valueWords(outage, 'h')} less outage time over 54 h and ${valueWords(outOfService, 'h')} fewer hours out of service, for ${valueWords(costMore, 'NOK')} more extra cost.`)
  })

  test('the unpriced caveat of each method, for both options; what is proven about the outage', () => {
    const text = lines(swap, [rebuild])
    const method = trainAInputs.methods[0]!
    const caveat = (option: string) => method.options.find(entry => entry.key === option)!.caveats![0]!
    expect(text).toContain(`Not in the ranking: ${caveat('swap').label}: ${valueWords(caveat('swap').value!, caveat('swap').unit!)} with 'Swap in refurbished spare', against ${valueWords(caveat('rebuild').value!, caveat('rebuild').unit!)} with 'Rebuild in place'.`)
    // Swap is proven optimal at 0 h over the target: the least possible, said with its proof.
    expect(text.at(-1)).toBe('Outage time over 54 h: 0 h, proven optimal: no plan has less (nothing is below 0 h).')
    // Rebuild, best found with a lower bound: "could be up to … better", never "proven".
    const named = lines(variantOf(rebuild, { key: 'rebuild-first' }), [variantOf(swap, { status: refused() })])
    const bound = rebuild.status.word === 'validated feasible' ? rebuild.status.goals[0]!.bound!.value : NaN
    expect(named.at(-1)).toBe(`Outage time over 54 h: ${valueWords(goal(rebuild, 0), 'h')}, best found; it could be up to ${valueWords(goal(rebuild, 0) - bound, 'h')} better.`)
    expect(named.join(' ')).not.toContain('proven optimal')
    // A proof on the outage over its target names its bound and certificate.
    const proven = lines(variantOf(rebuild, { status: provenOn(rebuild, 0) }), [])
    expect(proven.at(-1)).toStartWith(`Outage time over 54 h: ${valueWords(goal(rebuild, 0), 'h')}, proven optimal: no plan has less (`)
  })

  test('the options are named by their method, never by a rung label; two of one method keep their own labels (U1)', () => {
    const daysOnly = variantOf(swap, { label: 'Swap in refurbished spare: days only' })
    const withOvertime = variantOf(rebuild, { label: 'Rebuild in place: with Station mechanical crew overtime to 19:00' })
    const text = lines(daysOnly, [withOvertime])
    expect(text).toContain('Next in rank: \'Rebuild in place\'.')
    expect(text.join(' ')).not.toMatch(/days only|with Station/)
    expect(lines(daysOnly, [variantOf(withOvertime, { status: refused() })])).toContain('\'Swap in refurbished spare\' is the only ranked option that keeps every hard rule; 1 other does not.')
    // Swap at two rungs: the method alone would not tell them apart, so each keeps its label.
    expect(lines(variantOf(swap, { key: 'top' }), [variantOf(daysOnly, { key: 'low', status: found(swap) })])).toContain('Next in rank: \'Swap in refurbished spare: days only\'.')
  })

  test('the only ranked option; a named option, refused, a what-if solved first, or tied on every goal', () => {
    expect(lines(swap, [variantOf(rebuild, { status: refused() })])).toContain('\'Swap in refurbished spare\' is the only ranked option that keeps every hard rule; 1 other does not.')
    // A what-if with a lead is a card: never the next in rank.
    const lead = variantOf(rebuild, { key: 'cheapest', label: 'Cheapest that keeps every rule' })
    const leadOption = { ...lead, variant: { ...lead.variant, lead: { goal: 1 } }, status: { ...provenOn(rebuild, 1), lead: { goal: 1 } } } as Option
    expect(lines(swap, [leadOption])).toContain('\'Swap in refurbished spare\' is the only ranked option that keeps every hard rule.')
    expect(lines(swap, [leadOption], leadOption)).toContain('\'Cheapest that keeps every rule\' is a what-if that solves extra cost first: it is not ranked with the options.')
    const refusedOne = variantOf(rebuild, { status: refused() })
    expect(lines(swap, [refusedOne], refusedOne)).toContain('\'Rebuild in place\' is proven infeasible, so it is not ranked.')
    // Named: the comparison is with that option, whatever is next in rank.
    expect(lines(swap, [variantOf(rebuild, { key: 'r2', label: 'Rebuild, second look' }), rebuild], rebuild)).toContain('Against \'Rebuild in place\':')
    const twin = variantOf(swap, { key: 'swap-again', label: 'Swap, second look', status: found(swap) })
    const tied = lines(swap, [twin])
    fits(tied)
    expect(tied).toContain('They tie on every goal within its step, so either may be chosen; Planning lists \'Swap in refurbished spare\' first.')
  })
})

describe('the structure the words come from (coordinator decision, lane P batch 2, 3)', () => {
  test('recommended: the options, the deciding goal, each goal of both, the caveats and the outage goal\'s status', async () => {
    const { whyRecommended } = await import('./why.ts')
    const line = (option: Option, k: number) => option.status.word === 'validated feasible' ? option.status.goals[k]! : undefined
    const caveat = (option: string) => trainAInputs.methods[0]!.options.find(entry => entry.key === option)!.caveats![0]!
    expect(whyRecommended(trainAInputs, swap, [rebuild]).facts).toEqual({
      option: swap.key, against: rebuild.key, deciding: 0,
      goals: [0, 1, 2].map(k => ({ goal: k, value: goal(swap, k), against: goal(rebuild, k), unit: line(swap, k)!.unit })),
      caveats: [{ choice: trainAInputs.methods[0]!.key, option: 'swap', label: caveat('swap').label, value: caveat('swap').value!, unit: caveat('swap').unit!, against: caveat('rebuild').value! }],
      outage: { goal: 0, word: 'proven optimal', value: goal(swap, 0), unit: 'h', bound: line(swap, 0)!.bound!.value },
    })
    // Alone in the ranking: no comparison, no deciding goal.
    const alone = whyRecommended(trainAInputs, swap, []).facts
    expect([alone.against, alone.deciding, alone.goals.every(entry => entry.against === undefined)]).toEqual([undefined, undefined, true])
  })
})
