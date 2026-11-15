// The increment 2 walk fix round, lane U's items (impl/inc23/batch2-walk-fix-round.md; maint/walk-inc2.md):
// each test is written from the walk's own words, and failed before its fix.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'svelte'
import { versusFactsSchema } from '../api/contract.ts'
import { createPlanningClient } from './api.ts'
import { attentionCards } from './attention.ts'
import { floatText } from './explain-text.ts'
import { modelOf, optionOf, runBasis, status, trainACaseInputs, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, moneyText } from './format.ts'
import { ladderView, type BuysPage } from './ladder.ts'
import { createNames, type OptionView, type PlanModel } from './model.ts'
import { outcomeBanner } from './outcome.ts'
import { statusView, type Context } from './status-text.ts'
import { whatIfAskedNotice, whatIfCard, whatIfsClearedNotice } from './what-if.ts'
import { compareView, moreMoved, previousFor, whyView } from './why-text.ts'
import { recommendedFactsSchema } from '../api/contract.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: ComparePanel } = await import('./ComparePanel.svelte') as { default: Any }
const { default: Ladder } = await import('./Ladder.svelte') as { default: Any }
const { default: Library } = await import('./Library.svelte') as { default: Any }
const { default: StatusBlock } = await import('./StatusBlock.svelte') as { default: Any }
const { default: WhyRecommended } = await import('./WhyRecommended.svelte') as { default: Any }

const css = /<style>([\s\S]*)<\/style>/.exec(readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8'))?.[1] ?? ''
const inputs = trainACaseInputs()
const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const context = contextOf(modelOf(inputs))
const none = () => {}
/** The HTML a browser keeps: without Svelte's hydration markers. */
const plain = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '')
const grid = inputs.settings.grid
const method = inputs.methods[0]!
const picks = (option: string) => [{ choice: method.key, option }]
const label = (option: string) => method.options.find(entry => entry.key === option)!.label
const allowed = inputs.purchases.filter(purchase => purchase.allowed).map(purchase => purchase.key)
const feasible = (goals: unknown[]) => status({ word: 'validated feasible', run: runBasis(grid), goals })
const refusedStatus = () => status({ word: 'proven infeasible', run: runBasis(grid), cause: { kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }] } })

describe('V5: badges wrap inside the what-if card', () => {
  test('a long mark inside a card or a goal list may wrap, so it never runs past the card', () => {
    // The walk's badge: "best found with Auxiliary feedwater train A (motor-driven) first" ran off the card at 1440 px.
    expect(css).toMatch(/\.what-if-card \.mark, \.goals \.mark \{[^}]*white-space: normal;[^}]*max-width: 100%;[^}]*\}/)
  })
})

describe('V6: refused ladder rungs stay out of "Needs your attention"', () => {
  test('a refused option asked with less crew time than the plan allows gives no attention card; the plan\'s own refusal does', () => {
    // A lower rung stores its allowed purchases without the crew time it may not buy (lane S, solve/generate.ts).
    const crewTime = ['ot-mech', 'ot-elec', 'contractor-nights']
    const rung = optionOf('swap-days', `${label('swap')}: days only`, refusedStatus(), { variant: { methods: picks('swap'), purchases: allowed.filter(key => !crewTime.includes(key)) } })
    const own = optionOf('rebuild', label('rebuild'), refusedStatus(), { variant: { methods: picks('rebuild'), purchases: allowed } })
    // The rung is kept beside its method's own option, as the ladder leaves it.
    const swap = optionOf('swap', label('swap'), feasible([]), { variant: { methods: picks('swap'), purchases: allowed } })
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: [swap, rung, own] } })
    const titles = attentionCards(model, contextOf(model)).map(card => card.title)
    expect(titles.some(title => title.startsWith(`${label('swap')}: days only`))).toBe(false)
    expect(titles.some(title => title.startsWith(`${label('rebuild')}:`))).toBe(true)
  })
})

describe('V7 and V8: how the search ended, said once and in agreement with the options', () => {
  const stopped = (key: string, stoppedBy: 'wall' | 'memory') => optionOf(key, label(key), status({
    word: 'validated feasible', run: { ...runBasis(grid), stoppedBy }, goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }],
  }))
  test('the banner names the options that stopped early, with the same reason the options give', () => {
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: [stopped('swap', 'wall'), stopped('rebuild', 'wall')] } })
    const banner = outcomeBanner(model, contextOf(model))!
    expect(statusView(model.options!.items[0]!.status, contextOf(model)).run).toBe('The search stopped early, when its time was up.')
    expect(banner.lines).toEqual([`The search stopped early for ${label('swap')} and ${label('rebuild')}, when its time was up. The recommended option may not be the best. Generate again.`])
  })
  test('"The search stopped early: it reached the memory it may use."', () => {
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: [stopped('swap', 'memory')] } })
    expect(statusView(model.options!.items[0]!.status, contextOf(model)).run).toBe('The search stopped early: it reached the memory it may use.')
    expect(outcomeBanner(model, contextOf(model))!.lines[0]).toContain(`The search stopped early for ${label('swap')}: it reached the memory it may use`)
  })
})

describe('V10: every moved job is reachable', () => {
  test('"Show the other 27": the rest behind a disclosure, in plan order, when the Module pages them', () => {
    const jobs = inputs.jobs.slice(0, 8)
    const at = (hours: number) => new Date(Date.parse(inputs.settings.window!.start) + hours * 3_600_000).toISOString()
    const move = (index: number) => ({ job: jobs[index]!.key, was: { start: at(index), finish: at(index + 1) }, now: { start: at(index + 2), finish: at(index + 3) } })
    const facts = versusFactsSchema.parse({ option: 'a', previous: 'a', from: 1, to: 2, complete: true, changes: [], methods: [], buys: { added: [], dropped: [] }, moved: [move(5), move(0)], movedMore: 2, added: [], removed: [] })
    const more = versusFactsSchema.parse({ ...facts, moved: [move(7), move(3)], movedMore: 0 })
    const view = compareView(facts, { label: 'A' }, { label: 'A' }, context)
    const html = renderHtml(ComparePanel, { answer: { state: 'answered', facts: view }, more: moreMoved(more, context), onClose: none })
    // The outages are lines of their own, never a narrow table column that wraps a long group name (V11).
    const outages = compareView(versusFactsSchema.parse({ ...facts, outages: [{ group: 'COOL-A', now: 56.5, was: 54 }] }), { label: 'A' }, { label: 'A' }, context)
    expect(renderHtml(ComparePanel, { answer: { state: 'answered', facts: outages }, onClose: none })).toMatch(/<ul class="compare-outages">/)
    expect(html).toMatch(/<details[^>]*><summary>Show the other 2<\/summary>/)
    const rest = /<details[\s\S]*<\/details>/.exec(html)![0]
    expect(readableText(rest).indexOf(jobs[3]!.title)).toBeLessThan(readableText(rest).indexOf(jobs[7]!.title))
  })
})

describe('V11: wording', () => {
  test('a space after "found:", before "against", between a badge and its bound, and in "plan · changed"', () => {
    const view = ladderView([{ items: [
      { rung: { rung: 0, methods: [], buy: [], bought: [] } }, { rung: { rung: 1, methods: [], buy: [], bought: [] } },
      { row: { methods: [], from: 0, to: 1, ends: { from: 'found', to: 'found' }, word: 'found', outage: -2.5, cost: 1 } },
    ] } satisfies BuysPage], modelOf(inputs), context, null)
    expect(plain(renderHtml(Ladder, { view, state: 'ready', onSolve: none, onFiner: none, onSelect: none, onClose: none }))).toMatch(/found:<\/span> <span class="ladder-difference">/)
    const facts = recommendedFactsSchema.parse({ option: 'swap', against: 'rebuild', goals: [], caveats: [{ choice: method.key, option: 'swap', label: 'Weeks', value: 10, unit: 'weeks', against: 0 }] })
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: [optionOf('swap', label('swap'), feasible([])), optionOf('rebuild', label('rebuild'), feasible([]))] } })
    expect(plain(renderHtml(WhyRecommended, { title: 'Why', policy: [], answer: { state: 'answered', facts: whyView(facts, model, contextOf(model), false) }, onClose: none }))).toMatch(/10 weeks<\/strong> <span class="hint">against/)
    const bounded = statusView(feasible([{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }, { word: 'best found under budget', goal: 1, value: 472_650, unit: 'NOK', bound: { value: 340_000, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [] } } }]), context)
    expect(plain(renderHtml(StatusBlock, { view: bounded }))).toMatch(/best found<\/span> <span class="distance">/)
    const client = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => Response.json({ workspaceId: '0b4b9a52-2f7e-4c1a-9d3e-00000000000a', modules: [], resources: [], definitions: [] }))
    expect(readFileSync(join(import.meta.dir, 'Library.svelte'), 'utf8')).toContain(`<span class="hint">{\` · \${updated(plan)}\`}</span>`)
    expect(renderHtml(Library, { client, onOpen: none })).toBeTruthy()
  })

  test('"Float 0 s" becomes the margin in planner words', () => {
    expect(floatText({ workingHours: 0, limitedBy: { kind: 'window-end' } }, context)).toBe('No margin: any delay here moves the finish.')
    expect(floatText({ workingHours: 6, limitedBy: { kind: 'window-end' } }, context)).toBe('6 h of margin before the finish moves (limited by the window end; crew availability is not counted).')
  })

  test('every goal says its bound itself, never "could be up to X better"', () => {
    // The walk's case: the rebuild's 322.5 equipment-hours, with a bound far below.
    const line = (goal: number, value: number, unit: string, bound: number) => statusView(feasible([
      ...Array.from({ length: goal }, (_, index) => ({ word: 'best found under budget', goal: index, value: 0, unit: index === 1 ? 'NOK' : 'h' })),
      { word: 'best found under budget', goal, value, unit, bound: { value: bound, source: 'logic+calendars', certificate: { kind: 'least-outage', items: [] } } },
    ]), context).goals[goal]!.distance
    expect(line(2, 322.5, 'h', 28.5)).toBe('no plan has fewer than 28.5 equipment-hours out of service')
    expect(line(0, 13, 'h', 2)).toBe('no plan has less than 2 h over the 54 h guideline')
    expect(line(2, 322.5, 'h', 28.5)).not.toMatch(/could be up to/)
  })

  test('the "Weigh it against" list leaves out options that are not possible', () => {
    const source = readFileSync(join(import.meta.dir, 'PlanScreen.svelte'), 'utf8')
    expect(source).toMatch(/planOptions\(model\)\.filter\(option => option\.fresh && option\.status\.word === 'validated feasible' && option\.key !== recommendedOption\.key\)/)
  })
})

describe('V13: the what-if card says how it differs from the recommended option', () => {
  test('"Against Swap in refurbished spare (recommended): −1 h longest outage, +NOK 18,900 extra cost, back at the same time."', () => {
    // The walk's 48 h card against the recommended swap: 48 h against 49 h, NOK 491,550 against NOK 472,650,
    // the last test at the same hour. Stored figures in the options' own metrics; nothing is computed about a schedule.
    const goals = (cost: number) => [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }, { word: 'best found under budget', goal: 1, value: cost, unit: 'NOK' }]
    const metrics = (span: number, lastTest: number) => [{ id: 'goal:0:COOL-A', value: span, unit: 'h' }, { id: 'last-test', value: lastTest, unit: 'h' }]
    const recommended = optionOf('swap', label('swap'), feasible(goals(472_650)), { metrics: metrics(49, 60), variant: { methods: picks('swap'), purchases: [] } })
    const whatIf = optionOf('w48', 'At most 48 h out', feasible(goals(491_550)), { metrics: metrics(48, 60), variant: { methods: [], purchases: [], also: [{ kind: 'span-limit', key: 'w48', group: 'COOL-A', limit: { value: 48, unit: 'h' }, singleEntry: true, words: 'What-if', source: { by: 'planner' } }] } })
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: [recommended, whatIf] } })
    const card = whatIfCard(whatIf, model, contextOf(model))
    expect(card.against).toBe(`Against ${label('swap')} (recommended): −1 h longest outage, +${moneyText(491_550 - 472_650, 'NOK')} extra cost, back at the same time.`)
    expect(card.against).toBe(`Against ${label('swap')} (recommended): −1 h longest outage, +NOK 18,900 extra cost, back at the same time.`)
  })
})

describe('V3: the default comparison pairs the same method', () => {
  test('Rebuild now is compared with Rebuild before, whatever its key; with none, there is no default', () => {
    // After the 30 h edit and Generate, every key carries its set's suffix (lane P): rebuild.1d8017c1 now, rebuild.55ac0be0 before.
    const earlier = (key: string, option: string) => optionOf(key, label(option), feasible([]), { variant: { methods: picks(option), purchases: [] } })
    const page = { items: [earlier('swap.55ac0be0', 'swap'), earlier('rebuild.55ac0be0', 'rebuild')], recommended: 'swap.55ac0be0' }
    const shown: OptionView = optionOf('rebuild.1d8017c1', label('rebuild'), feasible([]), { variant: { methods: picks('rebuild'), purchases: [] } })
    expect(previousFor(shown, page, null)).toBe('rebuild.55ac0be0')
    expect(previousFor(shown, { items: [earlier('swap.55ac0be0', 'swap')], recommended: 'swap.55ac0be0' }, null)).toBeNull()
    expect(previousFor(shown, page, 'swap.55ac0be0')).toBe('swap.55ac0be0')
    expect(readableText(renderHtml(ComparePanel, { answer: { state: 'none' }, unpaired: true, onClose: none }))).toContain('The earlier set has no option of the same method. Choose one under “Compare with”.')
  })
})

describe('V2: an out-of-date option says what it was on the plan before the change', () => {
  test('"Out of date: on the plan before your latest change this was proven infeasible. Generate again to know for the plan as it is now."', () => {
    const text = readableText(renderHtml(StatusBlock, { view: statusView(refusedStatus(), context), stale: true }))
    expect(text).toContain('Out of date: on the plan before your latest change this was proven infeasible. Generate again to know for the plan as it is now.')
    expect(text).not.toContain('No plan was found in the time allowed')
  })
})

describe('V9: what-if cards never vanish without a word', () => {
  const card = (key: string, labelText: string) => optionOf(key, labelText, feasible([]), { variant: { methods: [], purchases: [], lead: { goal: 1 } } })
  test('the notice after an ask names the card it replaced; after Generate, it says why the what-ifs were cleared', () => {
    const afw = card('afw.55ac0be0', 'AFW A first'), cheapest = card('cheap.55ac0be0', 'Cheapest that keeps every rule')
    expect(whatIfAskedNotice('Cheapest that keeps every rule', [afw], [cheapest], true)).toBe('What-if answered: Cheapest that keeps every rule. It replaced “AFW A first”. Its card is on the right.')
    expect(whatIfAskedNotice('Cheapest that keeps every rule', [afw], [afw, cheapest], false)).toBe('What-if answered: Cheapest that keeps every rule. Its card is below.')
    expect(whatIfsClearedNotice([afw, cheapest], [])).toBe('The 2 what-ifs were asked against the earlier options, so Generate cleared them. Ask again for the plan as it is now.')
    expect(whatIfsClearedNotice([], [])).toBeNull()
  })
})
