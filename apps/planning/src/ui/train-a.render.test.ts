// The Train A plan on the screen, rendered on the server: what a planner reads first, the limits read
// from the plan's own rules and goals, marks by shape and word, and no ids, JSON or seconds anywhere.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { createPlanningClient } from './api.ts'
import { hourMs, identifiers, modelOf, trainAInputs, trainAPlanned, trainARows } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import type { PlanModel, PlanView } from './model.ts'

registerSvelte()
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Component<Record<string, unknown>> }

const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const html = (model: PlanModel, view: PlanView = 'schedule') => renderHtml(PlanScreen, {
  client: offline, planId: model.id, initial: model, initialView: view, onChanged: () => {}, onOpenWorkspace: () => {}, onOpenLibrary: () => {},
})
const screen = (model: PlanModel, view: PlanView = 'schedule') => readableText(html(model, view))
const labelsOf = (model: PlanModel): readonly string[] => [
  ...model.inputs.jobs.flatMap(job => [job.title, job.notBefore?.words ?? '', job.minimum?.words ?? '', ...job.checks.map(check => check.words)]),
  ...model.inputs.resources.flatMap(item => [item.label, item.words ?? '', item.source.note ?? '']), ...model.inputs.calendars.map(item => item.label),
  ...model.inputs.equipment.map(item => item.label), ...model.inputs.groups.map(item => item.label), ...model.inputs.purchases.map(item => item.label),
  ...model.inputs.methods.flatMap(method => [method.label, ...method.options.map(option => option.label)]),
  ...model.inputs.rules.flatMap(rule => [rule.words, rule.source.note ?? '']), model.inputs.settings.title, model.inputs.settings.purpose ?? '', model.inputs.settings.scenario?.title ?? '',
]
const views: readonly PlanView[] = ['schedule', 'add', 'equipment', 'crews', 'rules', 'options']
/** The cooling chain's limit and guideline in hours and the cost step, read from the fixture's rule and goals. */
const limitsOf = (model: PlanModel) => {
  const rule = model.inputs.rules.find(item => item.kind === 'span-limit' && item.group === 'COOL-A')
  const guideline = model.inputs.goals.find(goal => goal.metric === 'span-over' && goal.scope?.groups?.includes('COOL-A'))?.threshold
  const cost = model.inputs.goals.find(goal => goal.metric === 'extra-cost')?.tolerance
  if (rule?.kind !== 'span-limit' || rule.limit.unit !== 'h' || guideline?.unit !== 'h' || cost === undefined) throw new Error('The fixture changed shape')
  return { limit: rule.limit.value, guideline: guideline.value, cost: cost.value }
}

describe('Train A on the plan screen', () => {
  test('the first card asks to start the simulation in World and link it; Planning starts nothing itself', () => {
    const model = modelOf(trainAInputs())
    const text = screen(model)
    const attention = text.indexOf('Needs your attention')
    const card = text.indexOf(`Start the “${model.inputs.settings.scenario!.title}” simulation in World, then link it here.`)
    expect(card).toBeGreaterThan(attention)
    expect(text.slice(attention, card)).not.toContain('Generate makes')
    expect(text).toContain('it never starts, pauses or changes a simulation')
    expect(text).toContain('Open the Workspace')
    expect(text).toContain('Link the running simulation')
  })

  test('orientation comes from the plan: window, limits and guideline from its rules and goals, protected items, crews and their notes', () => {
    const model = modelOf(trainAInputs())
    const rules = screen(model, 'rules')
    const { limit, guideline, cost } = limitsOf(model)
    expect(rules).toContain(`out at most ${limit} h, from the first tag-out to the last passed test, as one continuous outage`)
    expect(rules).toContain(`Least time over the ${guideline} h guideline for ${model.inputs.groups.find(group => group.key === 'COOL-A')!.label}`)
    const protectedKeys = model.inputs.rules.flatMap(rule => rule.kind === 'protected' ? rule.equipment : [])
    expect(protectedKeys.length).toBeGreaterThan(0)
    for (const key of protectedKeys) expect(rules).toContain(model.inputs.equipment.find(item => item.key === key)!.label)
    expect(rules).toContain('Never tagged out, worked or tested: ')
    // R1 and R2 are reference rules: marked by shape and word, with the reference named.
    expect(rules).toContain('§ Reference')
    expect(rules).toContain('Window: Mon 16 Nov 07:00 to Sat 21 Nov 07:00 (Europe/Oslo).')
    expect(rules).toContain('Work-control operator (one tag-out or restoration at a time): One at a time.')
    expect(rules).toContain(`(compared in steps of NOK ${cost.toLocaleString('en-GB')})`)

    const crews = screen(model, 'crews')
    // Shift and crane hours in words, in the plan zone (T1).
    expect(crews).toContain('Works Mon–Fri 07:00–15:00; Mon–Fri 15:00–19:00 if “Station mechanical overtime to 19:00” is bought')
    expect(crews).toContain('Crane hours (crew and floodlights), Tue to Thu')
    expect(crews).toContain('Tue 07:00–19:00, Wed 07:00–19:00, Thu 07:00–19:00')
    expect(crews).toContain('Workshop rebuild and tube cleaning only.')
    expect(crews).toContain('2 crews of 3 · Day shift')
    expect(crews).toContain('NOK 50,400 per period used + NOK 35,000 once')
    expect(crews).toContain('⚑ Decision Order “Contractor night crew (nights Mon to Thu)” by Fri 12:00.')

    const work = screen(model)
    // Estimates show their range; the spare is a dated promise, flagged as an assumption, not a fact.
    expect(work).toContain('5 h of working time (4 h to 7 h)')
    expect(work).toContain('≈ Estimate')
  })

  test('at a glance: protected items and preconditions with their World state at read time, orders, crews and promises', () => {
    const inputs = trainAInputs()
    const swb = inputs.equipment.find(item => item.key === 'SWB')!
    const check = inputs.jobs.flatMap(job => job.checks)[0]!
    // Test input standing in for a refresh: World shows SW B running, read Thu 10:02.
    const fact = { locator: swb.locator!, id: check.fact, label: 'Running', quantity: 'state', value: check.expect, basis: 'observed' as const, at: '2026-11-12T09:02:00Z' }
    const read = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: '2026-11-12T09:00:00Z' } }, world: { refreshedAt: '2026-11-12T09:02:00Z', facts: [fact] } })
    const text = screen(read)
    expect(text).toContain('This plan at a glance')
    expect(text).toContain('Service Water Pump B is never touched.')
    expect(text).toContain('Running: yes · observed · read Thu 12 Nov 10:02 (simulation time)')
    expect(text).toContain('Met at read time: Running: yes · observed · read Thu 12 Nov 10:02')
    expect(text).toContain('is ready only if: World shows SW B running.')
    expect(text).toContain('60 t mobile crane with operator and rigger: Crane hours (crew and floodlights), Tue to Thu (Tue 07:00–19:00, Wed 07:00–19:00, Thu 07:00–19:00')
    expect(text).toContain('Order “Contractor night crew (nights Mon to Thu)” by Fri 12:00.')
    expect(text).toContain('“Rebook the eddy-current team to Friday” moves it.')
    expect(text).toContain('Crane hours (crew and floodlights), Tue to Thu')
    expect(text).toContain('depends on a promise, Mon 12:00.')
    const unread = screen(modelOf(inputs))
    expect(unread).toContain('Not read from World yet')
    expect(unread).not.toContain('Met at read time')
  })

  test('a planned option: each group against its limit and guideline, load per crew, float, and the honest status', () => {
    const model = trainAPlanned()
    const text = screen(model)
    const rows = trainARows(model.inputs)
    // SW A is out from the tag-out start to the test finish; everything it supports is out with it.
    const out = (Date.parse(rows[2]!.finish) - Date.parse(rows[0]!.start)) / hourMs
    expect(out).toBe(24 + 5 + 3.5)
    const { limit, guideline } = limitsOf(model)
    expect(out).toBeLessThan(guideline)
    // Back when the last passed test finishes: Tue 15:30.
    expect(text).toContain(`Out ${out} h of ${limit} h allowed, back Tue 15:30; ${limit - out} h margin; within the ${guideline} h guideline.`)
    expect(text).toContain('validated feasible')
    expect(text).toContain('proven optimal')
    expect(text).toContain('proven optimal')
    expect(text).toContain('best found')
    expect(text).not.toContain('best possible')
    expect(text).toContain('The search ran to the end.')
    expect(text).toContain('Station mechanical crew')
    expect(text).toContain('one at a time')
    expect(text).toContain('Float')
    expect(text).toContain('limited by: the window end (crew availability is not counted)')
    expect(text).toContain('Mon 07:00–10:00')
  })

  test('at phone width the attention cards come first, then the shift list, before the timeline', () => {
    const markup = html(trainAPlanned())
    const attention = markup.indexOf('Needs your attention')
    const shifts = markup.indexOf('Shift by shift')
    const timeline = markup.indexOf('aria-label="Timeline"')
    expect(attention).toBeGreaterThan(-1)
    expect(shifts).toBeGreaterThan(attention)
    expect(timeline).toBeGreaterThan(shifts)
    expect(markup).toContain('class="phone-only"')
    // A jump link at phone width leads past the cards to the views and forms.
    expect(markup).toContain('href="#plan-views"')
    expect(markup).toContain('id="plan-views"')
    expect(markup).toContain('class="desktop-only"')
  })

  test('routine views show no ids, JSON or seconds counts', () => {
    const planned = trainAPlanned()
    // Hand calculation: 16 h before the window end (Sat 07:00) is Fri 15:00, inside the window.
    const due = { kind: 'due' as const, key: 'D1', job: 'SWA-RTS', finishBy: new Date(Date.parse(planned.inputs.settings.window!.end) - 16 * hourMs).toISOString(), words: 'SW A back for the Friday surveillance.', source: { by: 'planner' as const } }
    const withDue = { ...planned, inputs: { ...planned.inputs, rules: [...planned.inputs.rules, due] } }
    expect(screen(withDue, 'rules')).toContain('Restore SW A, fill and vent, pump test must finish by Fri 15:00. No plan may finish it later.')
    expect(screen(withDue)).toContain('Restore SW A, fill and vent, pump test is due Fri 15:00')
    for (const model of [modelOf(trainAInputs()), planned, withDue]) {
      for (const view of views) {
        expect({ view, breaches: routineBreaches(screen(model, view), identifiers(model.inputs), labelsOf(model)) }).toEqual({ view, breaches: [] })
      }
    }
  })
})
