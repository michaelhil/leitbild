// Re-walk N2 on the screen (impl/inc23/batch2-rewalk-fixes.md), on the compact item (coordinator, after the
// re-walk sizes): the options section pages a refusal with each span as {rule, leastHours, limitHours} and per
// method a one-sentence `line`; the full chain (path, later start, energy proof) comes only from explain
// refusal, which "Why not possible" asks. On lane S's real record, "At most 40 h out" for the Train A cooling
// chain, stored in the Module and read back through the screen's own read (read-plan.ts) on the Module's API.
import { afterAll, describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { planWith, trainAInputs, type Option } from '../api/fixtures/choose.ts'
import { createHarness } from '../api/fixtures/harness.ts'
import { createRealSolver } from '../api/wiring.ts'
import { optionSchema } from '../plan/schema.ts'
import { generate, type AlsoRule, type GenerateDeps } from '../solve/generate.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound, laneKVerifySpan } from '../solve/fixtures/lane-k.ts'
import { createSolverPool } from '../solve/pool.ts'
import { searchEngine } from '../solve/search.ts'
import { moduleClient } from './fixtures/module-client.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, hoursText } from './format.ts'
import { createNames, type OptionView } from './model.ts'
import { createPlanActions } from './plan-actions.ts'
import { loadPlan } from './read-plan.ts'
import { certificateText, statusView, type Context } from './status-text.ts'
import { whatIfCard } from './what-if.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: WhatIfCard } = await import('./WhatIfCard.svelte') as { default: Any }
const none = () => {}

const pool = createSolverPool()
const harness = await createHarness({ solver: createRealSolver(pool) })
afterAll(async () => { await pool.shutdown(); await harness.close() })
const client = moduleClient(harness)

const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, verifySpan: laneKVerifySpan }
const context: Context = { inputs: trainAInputs, names: createNames(trainAInputs), format: createTimeFormat(trainAInputs.settings.timeZone) }
const at40: Extract<AlsoRule, { kind: 'span-limit' }> = { kind: 'span-limit', key: 'what-if-COOL-A-40h', group: 'COOL-A', limit: { value: 40, unit: 'h' }, singleEntry: true, words: 'What-if: Train A cooling chain back within 40 h.', source: { by: 'planner' } }
const [asked] = (await generate(deps, { inputs: trainAInputs, revision: 3, previous: null, input: { variants: [{ label: 'At most 40 h out', also: [at40] }] }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options
if (asked?.status.word !== 'proven infeasible' || asked.status.byMethod === undefined) throw new Error('lane S refuses the 40 h what-if for every method')
const refused = asked.status
// The same real record with one other method's span not stored, as a refusal without a span is kept: that
// method's sentence is then the `line` lane P's read words from its stored cause.
const other = refused.byMethod!.findIndex(entry => JSON.stringify(entry.methods) !== JSON.stringify(asked.variant.methods))
const { span: _dropped, ...unspanned } = refused.byMethod![other]!
const noSpan: Option = optionSchema.parse({ ...asked, key: 'at40-one-unspanned', label: 'At most 40 h out, one method without its span', status: { ...refused, byMethod: refused.byMethod!.map((entry, k) => k === other ? unspanned : entry) } })

const stored = await harness.store.create(harness.workspaceId, planWith(harness.workspaceId, [asked, noSpan]))
const read = await loadPlan(client, stored.id)
const item = (key: string): OptionView => read.options!.items.find(option => option.key === key)!
const actions = createPlanActions(client, stored.id)
const chain = await actions.whyNotPossible(asked.key)

describe('the compact item (shape E): each method\'s line exactly as the read gives it', () => {
  test('the read pages the refusal compact: one line per method, figures first, no path', () => {
    const shown = item(asked.key).status
    if (shown.word !== 'proven infeasible') throw new Error('refused')
    expect(shown.byMethod!.length).toBe(refused.byMethod!.length)
    // Each stored span's figures open one line, against the hours asked (lane P's read words them).
    for (const entry of refused.byMethod!) expect(shown.byMethod!.filter(line => line.line.startsWith(`Out at least ${entry.span!.leastHours} h, against the 40 h asked: `))).toHaveLength(1)
    expect(JSON.stringify(shown)).not.toMatch(/"path"|"later"|"alsoProven"|"methods"|"purchases"/)
  })

  test('the card says each line as given: no method prefix built, nothing stripped', () => {
    const option = item(asked.key)
    if (option.status.word !== 'proven infeasible') throw new Error('refused')
    const card = whatIfCard(option, read, context)
    expect(card.status.details).toEqual(option.status.byMethod!.map(entry => entry.line))
    expect(card.status.details.join(' ')).not.toContain('held by an outage limit')
    // A refused card shows no unpriced measures: there is no plan to leave anything unpriced.
    expect(card.unpriced).toEqual([])
  })

  test('a method without a stored span says the line the read gave from its cause, as given', () => {
    const option = item(noSpan.key)
    if (option.status.word !== 'proven infeasible') throw new Error('refused')
    const lines = option.status.byMethod!.map(entry => entry.line)
    expect(lines.filter(line => !line.startsWith('Out at least'))).toHaveLength(1)
    expect(whatIfCard(option, read, context).status.details).toEqual(lines)
  })

  test('a what-if refused with no lines by method: its own span against the rule asked, in that rule\'s words', () => {
    const option = item(asked.key)
    if (option.status.word !== 'proven infeasible' || option.status.span === undefined) throw new Error('the read gives the span summary')
    // The same compact item with one method combination only (a plan with one method has no lines by method).
    const { byMethod: _lines, ...single } = option.status
    const details = whatIfCard({ ...option, status: single }, read, context).status.details
    expect(details[0]).toBe(`Out at least ${hoursText(option.status.span.leastHours)}, against the ${hoursText(option.status.span.limitHours)} of “${at40.words}”.`)
    expect(details.join(' ')).not.toContain(at40.key)
  })
})

describe('N2: a span names its rule in the rule\'s own words, from span.rule', () => {
  test('"held by “<rule words>”", never "held by an outage limit"', () => {
    const rule = trainAInputs.rules.find(entry => entry.kind === 'span-limit' && entry.group === 'COOL-A')!
    const text = certificateText({ kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }, { job: 'SWA-RTS', via: 'link' }] }, context, { rule: rule.key })
    expect(text).toContain(`(held by “${rule.words}”)`)
    expect(text).not.toContain('an outage limit')
  })

  test('a plain refusal with a span summary says its least outage against its own rule', () => {
    const rule = trainAInputs.rules.find(entry => entry.kind === 'span-limit' && entry.group === 'COOL-A')!
    const option = item(asked.key)
    if (option.status.word !== 'proven infeasible' || option.status.span === undefined) throw new Error('the read gives the span summary')
    // The same compact shape on the plan's own rule (a stand-in: the plan's 72 h rule with the what-if's figures).
    const span = { ...option.status.span, rule: rule.key, limitHours: rule.kind === 'span-limit' ? rule.limit.value : 72 }
    const details = statusView({ word: 'proven infeasible', cause: option.status.cause, span, run: option.status.run }, context).details
    expect(details[0]).toBe(`Out at least ${hoursText(span.leastHours)}, against the ${hoursText(span.limitHours)} of “${rule.words}”.`)
  })
})

describe('"Why not possible" opens explain refusal: the full chain, fresh or out of date', () => {
  test('the action asks explain refusal for the option and gives its lines', async () => {
    const direct = (await harness.call('planning.plan.explain', { resource: stored.id, input: { ask: 'refusal', option: asked.key } })).body.result.lines as string[]
    expect(chain).toEqual(direct)
    // The full chain: the own method's proof with its path of jobs, which the compact item does not carry.
    expect(chain.some(line => line.startsWith('- '))).toBe(true)
  })

  test('a refused what-if card offers "Why not possible"; asked, it shows the chain, each job a row', () => {
    const card = whatIfCard(item(asked.key), read, context)
    const closed = readableText(renderHtml(WhatIfCard, { card, context, onSelect: none, onWhy: none }))
    expect(closed).toContain('Why not possible')
    const steps = chain.filter(line => line.startsWith('- ')).map(line => line.slice(2, line.lastIndexOf(': ')))
    for (const step of steps) expect(closed).not.toContain(step)
    const open = readableText(renderHtml(WhatIfCard, { card, context, why: { state: 'answered', facts: chain }, onSelect: none, onWhy: none }))
    for (const step of steps) expect(open).toContain(step)
    for (const line of chain.filter(entry => !entry.startsWith('- '))) expect(open).toContain(line)
  })

  test('while Planning answers, the card says it is asking', () => {
    const text = readableText(renderHtml(WhatIfCard, { card: whatIfCard(item(asked.key), read, context), context, why: { state: 'loading' }, onSelect: none, onWhy: none }))
    expect(text).toContain('Asking Planning for the proof')
  })

  test('out of date after an edit: the card says so, and the chain answers as the plan before the change', async () => {
    const job = trainAInputs.jobs.find(entry => entry.title === 'Rebuild SW A bowl assembly in workshop')!
    await client.edit(stored.id, read.revision, { edits: [{ edit: 'job', key: job.key, duration: { value: 30, unit: 'h' } }] })
    const after = await loadPlan(client, stored.id)
    const option = after.options!.items.find(entry => entry.key === asked.key)!
    expect(option.fresh).toBe(false)
    const lines = await actions.whyNotPossible(asked.key)
    expect(lines[0]).toBe('On the plan before your latest change: generate again to know for the plan as it is now.')
    const text = readableText(renderHtml(WhatIfCard, { card: whatIfCard(option, after, context), context, why: { state: 'answered', facts: lines }, onSelect: none, onWhy: none }))
    expect(text).toContain('Out of date')
    expect(text).toContain(lines[0]!)
  }, 60_000)
})
