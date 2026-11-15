// "Why recommended" and compare on the real structured outputs (coordinator, after lane P landed): lane P's
// own builders (plan/why.ts, plan/versus.ts) on its increment 1 Train A options (api/fixtures/choose.ts, made
// by the real solver and checker). The screen renders the facts, and none of the Module's lines.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { explainResultSchema } from '../api/contract.ts'
import { planWith, rebuild, swap, trainAInputs, variantOf } from '../api/fixtures/choose.ts'
import { versus } from '../plan/versus.ts'
import { whyRecommended } from '../plan/why.ts'
import { identifiers, modelOf, optionOf } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, quantityText } from './format.ts'
import { createNames, type OptionView } from './model.ts'
import type { Context } from './status-text.ts'
import { compareView, policyText, recommendedAnswer, versusAnswer, whyView } from './why-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: ComparePanel } = await import('./ComparePanel.svelte') as { default: Any }
const { default: WhyRecommended } = await import('./WhyRecommended.svelte') as { default: Any }

const context: Context = { inputs: trainAInputs, names: createNames(trainAInputs), format: createTimeFormat(trainAInputs.settings.timeZone) }
const none = () => {}
const view = (option: typeof swap): OptionView => optionOf(option.key, option.label, option.status, { variant: option.variant, metrics: option.metrics })
const model = modelOf(trainAInputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: swap.key, items: [view(swap), view(rebuild)] } })

describe('on the real structured outputs', () => {
  test('why recommended: the deciding goal, each goal against the next in rank, and the trade, from lane P\'s facts', () => {
    const real = whyRecommended(trainAInputs, swap, [rebuild])
    const answer = recommendedAnswer(explainResultSchema.parse({ lines: real.lines, items: [], recommended: real.facts }))
    if (answer.state !== 'answered') throw new Error('lane P answers with facts')
    const shown = whyView(answer.facts, model, context, false)
    const deciding = real.facts.goals.find(line => line.goal === real.facts.deciding)!
    expect(shown.decided).toBe(`Decided on over the 54 h guideline: ${quantityText(deciding.value, deciding.unit)} against ${quantityText(deciding.against!, deciding.unit)}.`)
    // The trade puts each cost before the gains it buys, in each goal's own unit, from the two values in the facts.
    const cost = real.facts.goals.find(line => line.goal === 1)!
    expect(shown.trade).toMatch(new RegExp(`^The trade: \\+${quantityText(cost.value - cost.against!, cost.unit).replace(/[.+]/g, '\\$&')} extra cost for −`))
    const text = readableText(renderHtml(WhyRecommended, { title: `Why “${swap.label}” is recommended`, policy: policyText(context), answer: { state: 'answered', facts: shown }, onClose: none }))
    expect(text).toContain(`Against “${rebuild.label}”, the next in rank.`)
    expect(text).toContain(shown.trade!)
    // None of the Module's lines is on the screen.
    for (const line of real.lines) expect(text).not.toContain(line)
    expect(routineBreaches(text, identifiers(trainAInputs), [])).toEqual([])
  })

  test('compare: the measures that changed and the jobs that moved, from lane P\'s facts', () => {
    // The swap now, against the rebuild kept under the swap's key at an earlier revision: methods, purchases,
    // measures and times all differ, as lane P's builder finds them.
    const plan = planWith('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', [swap], 3)
    const real = versus({ inputs: trainAInputs, option: swap, previous: variantOf(rebuild, { key: swap.key, label: rebuild.label, revision: 2 }), plan })
    const answer = versusAnswer(explainResultSchema.parse({ lines: real.lines, items: [], versus: real.facts }))
    if (answer.state !== 'answered') throw new Error('lane P answers with facts')
    const shown = compareView(answer.facts, view(swap), rebuild.label, context)
    expect(shown.moved.length).toBe(real.facts.moved.length)
    expect(shown.moved.length).toBeGreaterThan(0)
    expect(shown.goals!.map(row => row.name)).toEqual(real.facts.goals!.map(line => context.inputs.goals[line.goal]!).map(goal => goal.metric === 'span-over' ? 'Over the 54 h guideline' : goal.metric === 'extra-cost' ? 'Extra cost' : 'Equipment-hours out of service'))
    const text = readableText(renderHtml(ComparePanel, { answer: { state: 'answered', facts: shown }, onClose: none }))
    for (const entry of real.facts.moved) expect(text).toContain(context.names.job(entry.job))
    const method = trainAInputs.methods[0]!
    const label = (key: string) => method.options.find(option => option.key === key)!.label
    expect(text).toContain(`${method.label}: ${label('swap')}, was ${label('rebuild')}.`)
    for (const line of real.lines) expect(text).not.toContain(line)
    expect(routineBreaches(text, identifiers(trainAInputs), [])).toEqual([])
  })
})
