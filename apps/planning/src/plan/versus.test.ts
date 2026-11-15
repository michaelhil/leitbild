// "What differs from the earlier set" (design §6.3, T12): against an option of the previous set, the input
// changes between the two revisions from the change log, the goal values, the method and purchases, and
// each job that moved, was added or left. Expected lines are computed here from the two real options.
import { describe, expect, test } from 'bun:test'
import { explainResultSchema } from '../api/contract.ts'
import { planWith, rebuild, refused, swap, trainAInputs, variantOf, type Option } from '../api/fixtures/choose.ts'
import { nameOf, timeWords, valueWords } from './summary.ts'
import { versusLines } from './versus.ts'

const workspace = crypto.randomUUID()
const zone = trainAInputs.settings.timeZone
const goal = (option: Option, k: number) => option.status.word === 'validated feasible' ? option.status.goals[k]!.value : NaN
const longest = (option: Option) => Math.max(...option.metrics.filter(metric => metric.id.startsWith('goal:0')).map(metric => metric.value))
// The current set is on revision 4; the previous one was generated on revision 3.
const current = variantOf(rebuild, { revision: 4 })
const plan = planWith(workspace, [current], 4)
const compare = (option: Option, previous: Option, changes = plan.changes, droppedChanges = 0) => {
  const text = versusLines({ inputs: trainAInputs, option, previous, plan: { revision: 4, changes, droppedChanges } })
  expect(text.every(line => line.length <= 240)).toBe(true)
  expect(explainResultSchema.safeParse({ lines: text, items: [] }).success).toBe(true)
  return text
}

describe('what differs from an option of the previous set', () => {
  test('the changes since, the goal values, the method and purchases, and the jobs that moved, were added or left', () => {
    const text = compare(current, swap)
    expect(text[0]).toBe('\'Rebuild in place\' against \'Swap in refurbished spare\' of the previous options (revision 3; now revision 4).')
    expect(text).toContain('Changed since: Change 4.')
    expect(text).toContain(`Outage time over 54 h: ${valueWords(goal(rebuild, 0), 'h')}, was ${valueWords(goal(swap, 0), 'h')} (${valueWords(goal(rebuild, 0) - goal(swap, 0), 'h')} more).`)
    expect(text).toContain(`Extra cost: ${valueWords(goal(rebuild, 1), 'NOK')}, was ${valueWords(goal(swap, 1), 'NOK')} (${valueWords(goal(swap, 1) - goal(rebuild, 1), 'NOK')} less).`)
    // The outage goal's group, from its stored figure (G5); groups of other span rules need lane K's stored span figures.
    expect(text).toContain(`Longest outage of ${nameOf(trainAInputs, 'COOL-A')}: ${valueWords(longest(rebuild), 'h')}, was ${valueWords(longest(swap), 'h')} (${valueWords(longest(rebuild) - longest(swap), 'h')} longer).`)
    expect(text).toContain('SW A pump assembly: \'Rebuild in place\', was \'Swap in refurbished spare\'.')
    const label = (key: string) => trainAInputs.purchases.find(purchase => purchase.key === key)!.label
    const dropped = swap.variant.purchases.filter(key => !rebuild.variant.purchases.includes(key))
    expect(dropped.length).toBeGreaterThan(0)
    expect(text).toContain(`No longer buys: ${dropped.map(label).join(', ')}.`)
    // Jobs in both, at another start or finish, the largest shift first.
    const before = new Map(swap.rows.map(row => [row.job, row]))
    const moved = rebuild.rows.filter(row => before.has(row.job) && (before.get(row.job)!.start !== row.start || before.get(row.job)!.finish !== row.finish))
      .map(row => ({ row, shift: (Date.parse(row.start) - Date.parse(before.get(row.job)!.start)) / 3_600_000 }))
      .sort((left, right) => Math.abs(right.shift) - Math.abs(left.shift) || left.row.job.localeCompare(right.row.job))
    expect(moved.length).toBeGreaterThan(0)
    const first = moved[0]!
    expect(text).toContain(`${moved.length} jobs moved; the largest shifts first:`)
    expect(text).toContain(`'${nameOf(trainAInputs, first.row.job)}' starts ${timeWords(first.row.start, zone)}, was ${timeWords(before.get(first.row.job)!.start, zone)} (${valueWords(Math.abs(first.shift), 'h')} ${first.shift > 0 ? 'later' : 'earlier'}).`)
    const added = rebuild.rows.filter(row => !before.has(row.job)).map(row => nameOf(trainAInputs, row.job))
    expect(added.length).toBeGreaterThan(0)
    expect(text.find(line => line.startsWith('Added: '))).toStartWith(`Added: ${added.slice(0, 3).join(', ')}`)
    expect(text.find(line => line.startsWith('No longer in it: '))).toBeDefined()
  })

  test('goal values are compared only when the goals stayed as they were, and the history says what it no longer holds', () => {
    const reordered = [...plan.changes.slice(0, 3), { ...plan.changes[3]!, kinds: ['goals' as const], summary: 'Changed the goal order' }]
    const text = compare(current, swap, reordered)
    expect(text).toContain('Changed since: Changed the goal order.')
    expect(text).toContain('The goals changed since, so goal values are not compared.')
    // No goal value; the groups' longest outages are the checker's own span figures, not goal ids, so they stay.
    expect(text.some(line => line.startsWith('Outage time') || line.startsWith('Extra cost') || line.startsWith('Hours out of service'))).toBe(false)
    // The entry for revision 4 trimmed from the history: what changed is not known, so nothing is compared on goals.
    const trimmed = compare(current, swap, plan.changes.slice(0, 3).map(change => ({ ...change, revision: 3 })), 1)
    expect(trimmed).toContain('The history no longer holds every change since revision 3.')
    expect(trimmed).toContain('The goals may have changed since, so goal values are not compared.')
  })

  test('a status that differs is said first; the same schedule says no job moved', () => {
    const text = compare(current, variantOf(swap, { status: refused() }))
    expect(text[1]).toBe('Status: validated feasible, was proven infeasible.')
    expect(text.some(line => line.includes('moved'))).toBe(false)
    expect(compare(variantOf(swap, { revision: 4 }), swap)).toContain('No job moved.')
  })
})

describe('the longest outage of each group with a span rule (G5)', () => {
  test('from the checker\'s stored span figures, for every group a span rule names, in the lines and the facts', async () => {
    const { versus } = await import('./versus.ts')
    // The fixture options carry lane K's 'span:<group>' figures as Generate stores them.
    const now = current, was = swap
    const text = compare(now, was)
    const groups = [...new Set(trainAInputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [rule.group] : []))]
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) {
      const figure = (option: Option) => option.metrics.find(metric => metric.id === `span:${group}`)!.value
      const difference = figure(now) - figure(was)
      expect(text).toContain(`Longest outage of ${nameOf(trainAInputs, group)}: ${valueWords(figure(now), 'h')}${Math.abs(difference) < 1e-9 ? ', unchanged.' : `, was ${valueWords(figure(was), 'h')} (${valueWords(Math.abs(difference), 'h')} ${difference > 0 ? 'longer' : 'shorter'}).`}`)
    }
    // Every group with a span rule is in the facts, now and then, in h.
    const facts = versus({ inputs: trainAInputs, option: now, previous: was, plan: { revision: 4, changes: plan.changes, droppedChanges: 0 } }).facts
    const figure = (option: Option, group: string) => option.metrics.find(metric => metric.id === `span:${group}`)!.value
    expect(facts.outages).toEqual(groups.map(group => ({ group, now: figure(now, group), was: figure(was, group) })))
    // Without a stored figure for every such group, no outages are given in the facts.
    const without = variantOf(was, { metrics: was.metrics.filter(metric => metric.id !== `span:${groups.at(-1)}`) })
    expect(versus({ inputs: trainAInputs, option: now, previous: without, plan: { revision: 4, changes: plan.changes, droppedChanges: 0 } }).facts.outages).toBeUndefined()
  })
})

describe('the structure the words come from (coordinator decision, lane P batch 2, 3)', () => {
  test('versus: revisions, changes, goals while comparable, method, purchases and jobs, the largest shifts first', async () => {
    const { versus } = await import('./versus.ts')
    const facts = versus({ inputs: trainAInputs, option: current, previous: swap, plan: { revision: 4, changes: plan.changes, droppedChanges: 0 } }).facts
    const before = new Map(swap.rows.map(row => [row.job, row]))
    const moved = rebuild.rows.filter(row => before.has(row.job) && (before.get(row.job)!.start !== row.start || before.get(row.job)!.finish !== row.finish))
    expect(facts).toMatchObject({
      option: current.key, previous: swap.key, from: 3, to: 4, complete: true, changes: [{ revision: 4, summary: 'Change 4' }],
      goals: [0, 1, 2].map(k => ({ goal: k, now: goal(rebuild, k), was: goal(swap, k) })),
      methods: [{ choice: trainAInputs.methods[0]!.key, now: 'rebuild', was: 'swap' }],
      buys: { added: rebuild.variant.purchases.filter(key => !swap.variant.purchases.includes(key)), dropped: swap.variant.purchases.filter(key => !rebuild.variant.purchases.includes(key)) },
      movedMore: moved.length - 6,
      added: rebuild.rows.filter(row => !before.has(row.job)).map(row => row.job),
      removed: swap.rows.filter(row => !rebuild.rows.some(entry => entry.job === row.job)).map(row => row.job),
    })
    expect(facts.moved).toHaveLength(6)
    const first = facts.moved[0]!
    expect([first.now.start, first.was.start]).toEqual([rebuild.rows.find(row => row.job === first.job)!.start, before.get(first.job)!.start])
    // The goals changed since: no goal values in the structure either.
    const reordered = [...plan.changes.slice(0, 3), { ...plan.changes[3]!, kinds: ['goals' as const] }]
    expect(versus({ inputs: trainAInputs, option: current, previous: swap, plan: { revision: 4, changes: reordered, droppedChanges: 0 } }).facts.goals).toBeUndefined()
  })
})
