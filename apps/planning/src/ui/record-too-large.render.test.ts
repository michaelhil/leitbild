// A record larger than a page (lane P's 422 record_too_large, naming the section): the plan cannot open, and the
// whole-screen notice says so in planner words, never in the words of a refused change. On the real Module API:
// lane P's case, a plain option at the schema's most (64 purchases with 64-character keys), read through the
// screen's own actions.
import { afterAll, describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { createSolverDouble } from '../api/fixtures/doubles.ts'
import { formulation, planWith, swap, trainAInputs } from '../api/fixtures/choose.ts'
import { createHarness } from '../api/fixtures/harness.ts'
import { optionSchema, planInputsSchema } from '../plan/schema.ts'
import { recordTooLargeWords, refusalText } from './api.ts'
import { moduleClient } from './fixtures/module-client.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createPlanActions } from './plan-actions.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: ErrorNotice } = await import('./ErrorNotice.svelte') as { default: Any }

const harness = await createHarness({ solver: { ...createSolverDouble(), formulation: () => formulation } })
afterAll(() => harness.close())
const client = moduleClient(harness)

// Lane P's case (api/compact-p.test.ts): every purchase key at 64 characters, 64 purchases, all on one option.
const key = (stem: string) => stem.padEnd(64, 'x')
const originals = trainAInputs.purchases.map(purchase => purchase.key)
const renamed = <T>(value: T): T => JSON.parse(originals.reduce((text, from, k) => text.replaceAll(`"${from}"`, `"${key(`purchase-${k}-`)}"`), JSON.stringify(value)))
const base = renamed(trainAInputs)
const purchases = Array.from({ length: 64 }, (_, k) => base.purchases[k] ?? { ...base.purchases[k % base.purchases.length]!, key: key(`purchase-${k}-`) })
const inputs = planInputsSchema.parse({ ...base, purchases })
const wide = optionSchema.parse({ ...renamed(swap), variant: { ...renamed(swap).variant, purchases: purchases.map(purchase => purchase.key) } })
const plan = planWith(harness.workspaceId, [wide], 3, { inputs })
const stored = await harness.store.create(harness.workspaceId, { ...plan, previousOptions: { at: plan.options!.at, by: { kind: 'human' }, options: [{ ...wide, inputsRevision: 2 }] } })
const actions = createPlanActions(client, stored.id)
const refused = async (work: Promise<unknown>): Promise<unknown> => work.then(() => { throw new Error('the read was expected to be refused') }, (cause: unknown) => cause)
const changeWords = /This change|not valid/

describe('a record larger than a page: the plan cannot be shown, and nothing stored is lost', () => {
  test('opening the plan: the whole-screen notice in the coordinator\'s words, never a change refusal', async () => {
    const cause = await refused(actions.load(null))
    expect(cause).toMatchObject({ status: 422, code: 'record_too_large', details: { section: 'options' } })
    const words = refusalText(cause)
    expect(words).toBe('This plan cannot be shown: one of its options is too large for the list in this version of Planning. Nothing stored is lost.')
    expect(words).not.toMatch(changeWords)
    // The notice as the screen shows it when the plan cannot open: the words, no detail for support.
    const html = renderHtml(ErrorNotice, { text: words, cause })
    expect(readableText(html)).toContain(words)
    expect(html).not.toContain('<details')
  })

  test('the earlier set: its own sentence', async () => {
    const cause = await refused(actions.previous())
    expect(cause).toMatchObject({ code: 'record_too_large', details: { section: 'previous' } })
    expect(refusalText(cause)).toBe('This plan cannot be shown: one of its earlier options is too large for the list in this version of Planning. Nothing stored is lost.')
  })

  test('another section: its plain name as the screen shows it; with none, the sentence without a name; never the key', () => {
    const tooLarge = (section: string) => Object.assign(new Error('One record in this plan is too large to list.'), { status: 422, code: 'record_too_large', details: { section } })
    expect(refusalText(tooLarge('crews'))).toBe('This plan cannot be shown: one record of its crews and shifts is too large for this version of Planning. Nothing stored is lost.')
    expect(refusalText(tooLarge('sources'))).toBe('This plan cannot be shown: one record of its equipment and World is too large for this version of Planning. Nothing stored is lost.')
    for (const section of ['summary', 'jobs', 'history', 'buys', 'not-a-section']) {
      expect(refusalText(tooLarge(section))).toBe('This plan cannot be shown: one record is too large for this version of Planning. Nothing stored is lost.')
      expect(refusalText(tooLarge(section))).not.toContain(section)
    }
    for (const section of ['options', 'previous', 'schedule', 'rules', 'crews', 'sources']) expect(recordTooLargeWords(section)).not.toMatch(changeWords)
  })
})
