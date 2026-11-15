// The first increment 2 walk (maint/walk-inc2.md; impl/inc23/batch2-fix-round.md W1-W3): an answer the
// screen cannot read is said in planner words with the detail behind a disclosure; the Workspace plan card
// counts the plan's own options, never what-ifs; the pessimistic card's sentence on the other jobs.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { z } from 'zod'
import { summarize } from '../plan/store.ts'
import { planSchema, robustSchema } from '../plan/schema.ts'
import { planWith, swap, variantOf } from '../api/fixtures/choose.ts'
import { refusalText, unreadableAnswerWords } from './api.ts'
import { pessimisticCard } from './attention.ts'
import { trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: ErrorNotice } = await import('./ErrorNotice.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })

describe('W1: an answer the screen cannot read', () => {
  test('is said in planner words, with the raw detail only behind a disclosure for support', () => {
    // The kind of error the walk met: the screen's contract refusing a key the service sent.
    const parse = z.object({ result: z.object({ lines: z.array(z.string()) }).strict() }).strict().safeParse({ result: { lines: [], extra: 1 } })
    const cause = parse.success ? null : parse.error
    expect(unreadableAnswerWords).toBe('This screen could not read the plan\'s answer. Reload the page; if it happens again, send the details below to support.')
    expect(refusalText(cause)).toBe(unreadableAnswerWords)
    const html = renderHtml(ErrorNotice, { cause })
    const shown = readableText(html.replace(/<details[\s\S]*<\/details>/, ''))
    expect(shown).toContain(unreadableAnswerWords)
    expect(shown).not.toMatch(/unrecognized_keys|[{}]|":/)
    expect(html).toMatch(/<details[^>]*><summary>Details for support<\/summary><pre>[\s\S]*unrecognized_keys[\s\S]*<\/pre><\/details>/)
    // A refusal in planner words needs no disclosure.
    const refusal = Object.assign(new Error('Planning is busy'), { status: 503, code: 'planning_busy', details: null })
    expect(renderHtml(ErrorNotice, { cause: refusal })).not.toContain('<details')
  })
})

describe('W2: the Workspace plan card counts the plan\'s own options', () => {
  test('two options and a what-if count as two', () => {
    const whatIf = variantOf(swap, { key: 'cheapest', label: 'Cheapest that keeps every rule' })
    const lead = { ...whatIf, variant: { ...whatIf.variant, lead: { goal: 1 } } }
    const plan = planSchema.parse(planWith('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', [swap, variantOf(swap, { key: 'swap-2', label: 'Swap, again' }), { ...lead, status: { ...lead.status, ...(lead.status.word === 'validated feasible' ? { lead: { goal: 1 }, goals: lead.status.goals.map(goal => ({ word: 'best found under budget' as const, goal: goal.goal, value: goal.value, unit: goal.unit })) } : {}) } }]))
    expect(plan.options!.options).toHaveLength(3)
    expect(summarize(plan).optionCount).toBe(2)
  })
})

describe('W3: the other jobs with an estimate range', () => {
  test('"The other N jobs with an estimate range each hold alone at their high estimate"', () => {
    const planned = trainAPlanned()
    // Four jobs alone, one breaking (a stand-in for lane K's outcome, on the fixture's own rule and jobs).
    const breaks = { holds: false, rule: 'R2', job: 'SWA-RTS', by: { value: 3, unit: 'h' } }
    const robust = robustSchema.parse({ allPessimistic: breaks, single: [{ job: 'SWA-PUMP-OUT', outcome: breaks }, { job: 'SWA-TAG', outcome: { holds: true } }, { job: 'SWA-RTS', outcome: { holds: true } }, { job: 'SWA-SPARE-PREP', outcome: { holds: true } }] })
    const card = pessimisticCard({ ...planned.options!.items[0]!, robust }, contextOf(planned))!
    expect(card.steps.at(-1)).toBe('The other 3 jobs with an estimate range each hold alone at their high estimate.')
    const one = robustSchema.parse({ allPessimistic: breaks, single: [{ job: 'SWA-PUMP-OUT', outcome: breaks }, { job: 'SWA-TAG', outcome: { holds: true } }] })
    expect(pessimisticCard({ ...planned.options!.items[0]!, robust: one }, contextOf(planned))!.steps.at(-1)).toBe('The other job with an estimate range holds alone at its high estimate.')
  })
})
