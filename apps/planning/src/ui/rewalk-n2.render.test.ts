// Re-walk N2 on the screen (impl/inc23/batch2-rewalk-fixes.md): a refusal's hours come from the span stored with
// it, proven in the solver child; the rule is named in its own words; a refused card shows no unpriced
// measures. On lane S's real record: "At most 40 h out" for the Train A cooling chain (solve/whatif-refusal.test.ts).
import { describe, expect, test } from 'bun:test'
import { generate, type AlsoRule, type GenerateDeps } from '../solve/generate.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound, laneKVerifySpan } from '../solve/fixtures/lane-k.ts'
import { trainAInputs } from '../solve/fixtures/train-a-case.ts'
import { searchEngine } from '../solve/search.ts'
import { modelOf } from './fixtures/plans.ts'
import { createTimeFormat, hoursText } from './format.ts'
import { createNames, type OptionView } from './model.ts'
import { certificateText, statusView, type Context } from './status-text.ts'
import { whatIfCard } from './what-if.ts'

const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, verifySpan: laneKVerifySpan }
const flagship = trainAInputs({ read: true })
const context: Context = { inputs: flagship, names: createNames(flagship), format: createTimeFormat(flagship.settings.timeZone) }
const at40: Extract<AlsoRule, { kind: 'span-limit' }> = { kind: 'span-limit', key: 'what-if-COOL-A-40h', group: 'COOL-A', limit: { value: 40, unit: 'h' }, singleEntry: true, words: 'What-if: Train A cooling chain back within 40 h.', source: { by: 'planner' } }
const asked = (await generate(deps, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'At most 40 h out', also: [at40] }] }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options[0]!
const view = (stored: typeof asked): OptionView => ({ key: stored.key, label: stored.label, variant: stored.variant, status: stored.status, metrics: stored.metrics, inputsRevision: 1, fresh: true, warnings: [] })
const label = (option: string) => flagship.methods[0]!.options.find(entry => entry.key === option)!.label

describe('N2: a refused what-if says each method\'s least outage against the limit asked', () => {
  test('"<method>: out at least <leastHours> h, against the <limitHours> h asked", from each stored span', () => {
    if (asked.status.word !== 'proven infeasible') throw new Error('lane S refuses the 40 h what-if')
    const spans = (asked.status.byMethod ?? []).flatMap(entry => entry.span === undefined ? [] : [{ method: label(entry.methods[0]!.option), span: entry.span }])
    expect(spans.length).toBeGreaterThan(0)
    const card = whatIfCard(view(asked), modelOf(flagship, { options: { at: '2026-11-12T09:05:00.000Z', recommended: null, items: [view(asked)] } }), context)
    for (const { method, span } of spans) expect(card.status.details).toContain(`${method}: out at least ${hoursText(span.leastHours)}, against the ${hoursText(span.limitHours)} asked.`)
    expect(card.status.details.join(' ')).not.toContain('held by an outage limit')
    // A refused card shows no unpriced measures: there is no plan to leave anything unpriced.
    expect(card.unpriced).toEqual([])
  }, 120_000)
})

describe('N2: a span step names its rule in the rule\'s own words', () => {
  test('"held by “<rule words>”", never "held by an outage limit"', () => {
    const rule = flagship.rules.find(item => item.kind === 'span-limit' && item.group === 'COOL-A')!
    const text = certificateText({ kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }, { job: 'SWA-RTS', via: 'link' }] }, context, { rule: rule.key })
    expect(text).toContain(`(held by “${rule.words}”)`)
    expect(text).not.toContain('an outage limit')
  })

  test('a plain refusal with a stored span says its least outage against its own rule', () => {
    const rule = flagship.rules.find(item => item.kind === 'span-limit' && item.group === 'COOL-A')!
    if (asked.status.word !== 'proven infeasible') throw new Error('lane S refuses the 40 h what-if')
    const entry = (asked.status.byMethod ?? []).find(item => item.span !== undefined)
    if (entry?.span === undefined) throw new Error('lane S stores a span')
    // The same stored shape on the plan's own rule (a stand-in: the plan's 72 h rule with the what-if's figures).
    const span = { ...entry.span, rule: rule.key, limitHours: rule.kind === 'span-limit' ? rule.limit.value : 72 }
    const details = statusView({ word: 'proven infeasible', cause: entry.cause, span, run: asked.status.run }, context).details
    expect(details[0]).toBe(`Out at least ${hoursText(span.leastHours)}, against the ${hoursText(span.limitHours)} of “${rule.words}”.`)
  }, 120_000)
})
