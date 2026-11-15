// The last items before the release, from the goals guardian's final check.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { createPlanningClient } from './api.ts'
import { attentionCards } from './attention.ts'
import { modelOf, optionOf, runBasis, status, trainAInputs } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import { outcomeBanner } from './outcome.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: Library } = await import('./Library.svelte') as { default: Any }
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }

const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}

describe('before the release', () => {
  test('the library says what this release is, with no internal names', () => {
    const text = readableText(renderHtml(Library, { client: offline, onOpen: none }))
    expect(text).toContain('First release: build a plan, generate options and see why. Recording progress and replanning after disruptions come next.')
    expect(text).not.toMatch(/increment|Release A|phase/i)
  })

  test('a span-limit refusal shows its hours on the plan screen itself: in the options table and in its detail', () => {
    const inputs = trainAInputs()
    const refused = status({ word: 'proven infeasible', run: runBasis(inputs.settings.grid), cause: { kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }, { job: 'SWA-RTS', via: 'link' }] } })
    const rule = inputs.rules.find(item => item.kind === 'span-limit')!.words
    // The Module's refusal as explain gives it (a hand-written stand-in in its form): the rule, the hours,
    // then a heading and the list of jobs, which stay in the explain view.
    const lines = [
      `Not possible: ${rule}`,
      'The shortest span this plan allows is 80.5 h, against 72 h: first tag-out Mon 21:00, last test passed Fri 05:30.',
      'What sets the last test, each job at its earliest:',
      '- Remove SW A from service and hang tags: Mon 21:00 to Tue 00:00',
    ]
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: null, items: [optionOf('v2', 'Swap in refurbished spare, days only', refused)] }, refusals: { v2: lines } })
    const hours = 'The shortest span this plan allows is 80.5 h, against 72 h'
    // Walk 7: the cause is said once in the table and once in full in the option's detail, not in the banner or a card.
    expect(outcomeBanner(model, contextOf(model))!.lines).toEqual([])
    const card = attentionCards(model, contextOf(model)).find(item => item.title.startsWith('Swap in refurbished spare, days only'))!
    expect(card.text).not.toContain(hours)
    const screen = readableText(renderHtml(PlanScreen, { client: offline, planId: model.id, initial: model, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))
    expect(screen.split(hours).length - 1).toBe(2)
    expect(screen).toContain(`Not possible: ${hours}.`)
    expect(screen).not.toContain('- Remove SW A from service and hang tags: Mon 21:00')
  })
})
