// Increment 2 "Choose", the journey's steps 1-4 (design §7, §8 "Journey, batch 2"), through the plan screen's
// own client (ui/api.ts: Host's invoke route, actor kind human) on real World, Host and Planning, from the
// Train A Definition: understand, first plan, explore, change and compare. Every result fits 4 KB, and the
// Run's World journal gains nothing. Planning runs on lane S's solver and lane K's checker; lane K's own judge
// (buysHonesty) reads every "what overtime buys" section.
import { afterAll, expect, test } from 'bun:test'
import { buysHonesty } from '../../../apps/planning/tests/harness/buys-honesty.ts'
import { sectionDataSchemas } from '../../../apps/planning/src/api/contract.ts'
import { rungsOf } from '../../../apps/planning/src/plan/buys.ts'
import { methodCombinations } from '../../../apps/planning/src/solve/keys.ts'
import { ladderRungs, rungRequest } from '../../../apps/planning/src/solve/ladder.ts'
import { formulationOf } from '../../../apps/planning/src/solve/compile.ts'
import { createPlanningClient } from '../../../apps/planning/src/ui/api.ts'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack()
afterAll(() => stack.close())
const client = createPlanningClient(stack.workspaceId, (input, init) => fetch(`${stack.hostUrl}${String(input)}`, init))
const small = <T>(result: T): T => {
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(4_096)
  return result
}
// The screen's own budget (Generate's default): at 10 s the rebuild is not always found under load.
const seconds = 20
const stored = (planId: string) => stack.store.read(stack.workspaceId, planId)
const buys = async (planId: string) => sectionDataSchemas.buys.parse(small(await client.read(planId, { section: 'buys' })).sections[0]!.data).items
type BuysItem = Awaited<ReturnType<typeof buys>>[number]
/** The items of one method's ladder: one ladder per method (U3). */
const methodOf = (item: BuysItem) => JSON.stringify('rung' in item ? item.rung.methods : item.row.methods)
const perMethod = (items: readonly BuysItem[]) => [...new Set(items.map(methodOf))].map(method => items.filter(item => methodOf(item) === method))

/** Steps 1 and 2: the Definition's Scenario started by a person, the plan created, linked and refreshed; days only refused, then with purchases. */
const firstPlan = async () => {
  const runId = await stack.start('world.scenario', 'train-a-work-week', 'world.scenario.start')
  const journal = stack.runEvents(runId)
  const definition = (await client.definitions()).definitions.find(entry => entry.ref.id === 'train-a-work-week')!
  const created = small(await client.create(definition)).result
  const planId = created.plan.id
  const linked = small(await client.edit(planId, created.plan.revision, { edits: [{ edit: 'plan', run: runId }] }))
  const refreshed = small(await client.refresh(planId, linked.plan.revision))
  expect(refreshed.problems).toEqual([])
  const revision = refreshed.plan.revision
  // Days only, both methods: refused with a certificate (T5), each explained in hours.
  const daysOnly = small(await client.generate(planId, revision, { seconds, variants: [
    { label: 'V1 days only, rebuild', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' },
    { label: 'V2 days only, swap', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'no-extra-crew-hours' },
  ] }))
  expect(daysOnly.options.map(option => option.status.word)).toEqual(['proven infeasible', 'proven infeasible'])
  for (const option of daysOnly.options) expect(small(await client.explain(planId, { ask: 'refusal', option: option.key })).lines.join(' ')).toMatch(/Not possible: .*\d h/)
  const withPurchases = small(await client.generate(planId, revision, { seconds }))
  expect(withPurchases.options.map(option => option.status.word)).toEqual(['validated feasible', 'validated feasible'])
  return { runId, journal, planId, revision, recommended: withPurchases.recommended! }
}

test('steps 1, 2 and 4: first plan, why recommended, the rungs to solve; seal at 14 h, Generate, and what differs from the earlier set', async () => {
  const { runId, journal, planId, revision, recommended } = await firstPlan()

  // Step 3's reads: why the recommended option ranks first (T11), and the rungs of bought crew time to solve.
  const reason = small(await client.explain(planId, { ask: 'recommended' })).lines
  console.log('why recommended:', reason.join(' | '))
  expect(reason[0]).toStartWith('Ranked by: every hard rule kept first, then outage time')
  expect(reason.some(line => line.startsWith('Next in rank: ') || line.includes('the only ranked option'))).toBe(true)
  expect(reason.some(line => line.startsWith('Not in the ranking: Weeks without a ready SW spare'))).toBe(true)
  const plan = await stored(planId)
  const ladder = await buys(planId)
  // One ladder per method, each with every rung and its buy list, each rung naming its method.
  const methods = methodCombinations(plan.inputs)
  expect(ladder.flatMap(item => 'rung' in item ? [[item.rung.methods, item.rung.buy]] : [])).toEqual(methods.flatMap(combo => rungsOf(plan.inputs).map(rung => [combo, [...rung.buy]])))
  for (const items of perMethod(ladder)) expect(buysHonesty(plan, items, formulationOf(plan.inputs.settings.grid))).toEqual([])

  // Step 4: the seal at 14 h, its high estimate, previewed on the recommended option, then saved; Generate again;
  // what differs from the earlier set (T12). With its current order the option breaks what the pessimistic card
  // says the seal alone at its high estimate breaks: the preview and the card re-time by the same repair.
  const seal = plan.inputs.jobs.find(job => job.title === 'Replace CCW A mechanical seal')!
  expect(seal.duration.range?.high).toBe(14)
  const edits = [{ edit: 'job' as const, key: seal.key, duration: { value: 14, unit: 'h' as const } }]
  const preview = small(await client.edit(planId, revision, { edits, preview: true })).preview!
  console.log('seal at 14 h:', preview.consequence)
  const option = plan.options!.options.find(entry => entry.key === recommended)!
  // The card's re-timing of the seal alone at its high estimate (absent when Generate had no time to work it out).
  const robust = option.robust
  const card = robust !== undefined && 'single' in robust ? robust.single.find(entry => entry.job === seal.key)?.outcome : undefined
  console.log('the card for the seal at 14 h:', JSON.stringify(card ?? robust ?? null))
  const label = plan.inputs.methods.flatMap(choice => choice.options).find(entry => option.variant.methods.some(pick => pick.option === entry.key))!.label
  expect(preview.saved).toBe(false)
  // The preview says what the card says of the seal alone at its high estimate: it holds, or what it breaks.
  if (card === undefined || card.holds) {
    expect(preview.consequence).toMatch(new RegExp(`^Not saved yet\\. On '${label}': \\d+ jobs? moves?; the last finish `))
  } else {
    expect(preview.consequence).toStartWith(`With its current order, '${label}' would break: `)
    expect(preview.consequence).toEndWith('Generate again to look for a new order.')
    if ('rule' in card) {
      const rule = plan.inputs.rules.find(entry => entry.key === card.rule)!
      const group = rule.kind === 'span-limit' ? plan.inputs.groups.find(entry => entry.key === rule.group)!.label : ''
      expect(preview.consequence).toContain(rule.kind === 'span-limit' ? `the ${rule.limit.value} ${rule.limit.unit} limit on ${group}` : rule.words)
    }
    if ('unplaced' in card) expect(preview.consequence).toContain(`'${plan.inputs.jobs.find(entry => entry.key === card.unplaced.job)!.title}' could not be done`)
  }
  const saved = small(await client.edit(planId, revision, { edits, reason: 'The seal vendor now quotes 14 h' }))
  expect(saved.plan.revision).toBe(revision + 1)
  const earlier = (await stored(planId)).options!
  const again = small(await client.generate(planId, saved.plan.revision, { seconds }))
  expect(again.options.some(option => option.status.word === 'validated feasible')).toBe(true)
  expect((await stored(planId)).previousOptions).toEqual(earlier)
  const versus = small(await client.explain(planId, { ask: 'versus', versus: { previous: recommended } })).lines
  console.log('versus previous:', versus.join(' | '))
  expect(versus[0]).toContain(`of the previous options (revision ${revision}; now revision ${revision + 1}).`)
  expect(versus.some(line => line.startsWith('Changed since: Changed job Replace CCW A mechanical seal'))).toBe(true)

  // Planning read World and wrote nothing there.
  expect(stack.runEvents(runId)).toBe(journal)
}, 300_000)

test('step 3: the ladder solved bottom-up with keep, its rows honest by lane K; at most 48 h out; cheapest that keeps every rule', async () => {
  const { runId, journal, planId, revision } = await firstPlan()
  // One Generate per rung, lowest first, with keep: lane S's per-method requests, as the screen sends them
  // (solve/ladder.ts rungRequest; the top rung is the plain kept Generate).
  const plan = await stored(planId)
  const label = (combo: readonly { readonly option: string }[]) => combo.map(pick => plan.inputs.methods.flatMap(choice => choice.options).find(option => option.key === pick.option)!.label).join(', ')
  for (const rung of ladderRungs(plan.inputs)) small(await client.generate(planId, revision, { seconds, ...rungRequest(plan.inputs, rung, combo => `${label(combo)}: rung ${rung.rung + 1}`) }))
  const solved = await stored(planId)
  const ladder = await buys(planId)
  console.log('what overtime buys:', JSON.stringify(ladder))
  // A three-rung ladder per method, every rung solved, with its rows, and every word honest by lane K.
  const ladders = perMethod(ladder)
  expect(ladders).toHaveLength(methodCombinations(plan.inputs).length)
  for (const items of ladders) {
    expect(items.filter(item => 'rung' in item && item.rung.option !== undefined)).toHaveLength(rungsOf(plan.inputs).length)
    expect(items.filter(item => 'row' in item).length).toBeGreaterThan(0)
    expect(buysHonesty(solved, items, formulationOf(solved.inputs.settings.grid))).toEqual([])
  }

  // At most 48 h out: a what-if with one extra hard rule, under a key no plan rule has (T8).
  const span = plan.inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === 'COOL-A')!
  const at48 = small(await client.generate(planId, revision, { seconds, keep: true, variants: [{ label: 'At most 48 h out', also: [{ kind: 'span-limit', key: 'W48', group: 'COOL-A', limit: { value: 48, unit: 'h' }, singleEntry: true, words: 'Train A cooling chain back within 48 h', source: { by: 'planner' } }] }] }))
  expect(at48.options.some(option => option.label === 'At most 48 h out')).toBe(true)
  expect(span.key).not.toBe('W48')
  // Cheapest that keeps every rule: the extra-cost goal solved first, a card, never recommended.
  const extraCost = plan.inputs.goals.findIndex(goal => goal.metric === 'extra-cost')
  const cheapest = small(await client.generate(planId, revision, { seconds, keep: true, variants: [{ label: 'Cheapest that keeps every rule', lead: { goal: extraCost } }] }))
  const card = cheapest.options.find(option => option.label === 'Cheapest that keeps every rule')!
  expect(card.status.lead).toEqual(card.status.word === 'validated feasible' ? { goal: extraCost } : undefined)
  expect(cheapest.recommended).not.toBe(card.key)
  expect(small(await client.explain(planId, { ask: 'recommended' })).lines[0]).toStartWith('Ranked by:')
  expect(stack.runEvents(runId)).toBe(journal)
}, 300_000)
