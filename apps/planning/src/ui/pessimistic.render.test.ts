// The pessimistic card (design §4.2, §7 AttentionColumn; robust {allPessimistic, single[]}): the recommended
// option re-timed with every ranged job at its high estimate, then each alone, as the checker judged it. It
// names the rule broken, the job and by how much, or the job that would run past the window end and when. The
// unplaced job is tested on the real stored Train A case in fix-round-u.render.test.ts.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { robustSchema } from '../plan/schema.ts'
import { attentionCards, pessimisticCard } from './attention.ts'
import { identifiers, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: AttentionColumn } = await import('./AttentionColumn.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
/** The hand-placed Train A option with a re-timing outcome, as the schema takes it. */
const withRobust = (robust: unknown): PlanModel => {
  const planned = trainAPlanned()
  return { ...planned, options: { ...planned.options!, items: planned.options!.items.map(option => ({ ...option, robust: robustSchema.parse(robust) })) } }
}
const name = (model: PlanModel, key: string) => model.inputs.jobs.find(job => job.key === key)?.title ?? model.inputs.rules.find(rule => rule.key === key)!.words

describe('the pessimistic card', () => {
  test('when every re-timing holds, it says so, and how the re-timing was done', () => {
    const model = withRobust({ allPessimistic: { holds: true }, single: [{ job: 'SWA-PUMP-OUT', outcome: { holds: true } }] })
    const card = pessimisticCard(model.options!.items[0]!, contextOf(model))!
    expect(card.title).toBe('At every high estimate, Option 1 still keeps every hard rule and fits the window.')
    expect(card.text).toBe('Re-timed in the same order with the same crews, nothing earlier, and checked. A plan made again at those estimates may do better.')
  })

  test('a broken rule is named with its job and by how much; a job alone that breaks one is listed', () => {
    // A stand-in for the checker's outcome, in the schema's form, on the fixture's own rule and jobs. The 3 h is
    // or's re-timed figure on the frozen case, 75 h against the 72 h limit (R/or/report.md, the +25 % row).
    const over = { value: 75 - 72, unit: 'h' }
    const model = withRobust({
      allPessimistic: { holds: false, rule: 'R2', job: 'SWA-RTS', by: over },
      single: [{ job: 'SWA-PUMP-OUT', outcome: { holds: false, rule: 'R2', job: 'SWA-RTS', by: over } }, { job: 'SWA-TAG', outcome: { holds: true } }],
    })
    const cards = attentionCards(model, contextOf(model))
    const card = cards.find(item => item.mark.word === 'Pessimistic estimates')!
    expect(card.title).toBe(`With every job with an estimate range at its high estimate, Option 1 does not hold: ${name(model, 'SWA-RTS')} breaks “${name(model, 'R2')}” by 3 h.`)
    expect(card.steps).toEqual([`${name(model, 'SWA-PUMP-OUT')} alone at its high estimate: ${name(model, 'SWA-RTS')} breaks “${name(model, 'R2')}” by 3 h.`, '1 other job with an estimate range holds alone at its high estimate.'])
    // It follows the recommended option's own card.
    expect(cards.indexOf(card)).toBe(cards.findIndex(item => item.title === 'Option 1: validated feasible.') + 1)
    const text = readableText(renderHtml(AttentionColumn, { cards, onAction: none }))
    expect(text).toContain('Why recommended?')
    expect(routineBreaches(text, identifiers(model.inputs), [])).toEqual([])
  })

  test('a job that would run past the window end says so, with the time it would end', () => {
    const end = trainAPlanned().inputs.settings.window!.end
    const by = new Date(Date.parse(end) + 2 * 3_600_000).toISOString()
    const model = withRobust({ allPessimistic: { holds: false, window: { by }, job: 'SWA-RTS' }, single: [] })
    const card = pessimisticCard(model.options!.items[0]!, contextOf(model))!
    expect(card.title).toBe(`With every job with an estimate range at its high estimate, Option 1 does not hold: ${name(model, 'SWA-RTS')} would run past the window end, to ${contextOf(model).format.when(by)}.`)
  })

  test('no card for an option without a re-timing, a stale one, or one that is not validated feasible', () => {
    const model = trainAPlanned()
    expect(pessimisticCard(model.options!.items[0]!, contextOf(model))).toBeNull()
    const stale = withRobust({ allPessimistic: { holds: true }, single: [] })
    expect(pessimisticCard({ ...stale.options!.items[0]!, fresh: false }, contextOf(stale))).toBeNull()
  })
})
