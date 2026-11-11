// The Supply run renders on the same generic screen as Train A: trucks as crew-and-tool lanes, requests
// as jobs, the coverage rule in words, lateness against each target. No Supply-run component exists.
import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import type { Component } from 'svelte'
import { createPlanningClient } from './api.ts'
import { identifiers, modelOf, supplyRunInputs, supplyRunPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import type { PlanModel, PlanView } from './model.ts'

registerSvelte()
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Component<Record<string, unknown>> }

// A client whose transport refuses every call: rendering on the server must not reach Host.
const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const screen = (model: PlanModel, view: PlanView = 'schedule') => readableText(renderHtml(PlanScreen, {
  client: offline, planId: model.id, initial: model, initialView: view, onChanged: () => {}, onOpenWorkspace: () => {}, onOpenLibrary: () => {},
}))
const labelsOf = (model: PlanModel): readonly string[] => [
  ...model.inputs.jobs.map(job => job.title), ...model.inputs.resources.map(item => item.label), ...model.inputs.calendars.map(item => item.label),
  ...model.inputs.equipment.map(item => item.label), ...model.inputs.rules.map(rule => rule.words), ...model.inputs.world.facts.map(fact => fact.label),
  model.inputs.settings.title, model.inputs.settings.purpose ?? '', model.inputs.settings.scenario?.title ?? '',
  ...model.inputs.resources.flatMap(item => [item.words ?? '', item.source.note ?? '', ...item.attributes.map(attribute => attribute.label)]),
  ...model.inputs.calendars.map(item => item.source.note ?? ''), ...model.inputs.rules.map(rule => rule.source.note ?? ''),
  ...model.inputs.jobs.flatMap(job => [job.target?.words ?? '', job.notBefore?.words ?? '', 'note' in job.duration.origin ? job.duration.origin.note ?? '' : '']),
]
const views: readonly PlanView[] = ['schedule', 'add', 'equipment', 'crews', 'rules', 'options']

describe('Supply run on the generic screen', () => {
  test('there are no Supply-run components: every component is generic', () => {
    const components = readdirSync(import.meta.dir).filter(name => name.endsWith('.svelte'))
    expect(components.filter(name => /supply|truck|einsatz|request|dispatch/i.test(name))).toEqual([])
  })

  test('before a Run is linked, the first card guides start, link and read; World durations are not read yet', () => {
    const model = modelOf(supplyRunInputs())
    const text = screen(model)
    const scenario = model.inputs.settings.scenario!.title
    expect(text).toContain(`Start the “${scenario}” simulation in World, then link it here.`)
    expect(text.indexOf(`Start the “${scenario}”`)).toBeLessThan(text.indexOf('Needs your attention') + 400)
    expect(text).toContain('Link the running simulation')
    expect(text).toContain('Not read from World yet')
    // Never a number for an unread World duration.
    for (const job of model.inputs.jobs) expect(text).toContain(job.title)
  })

  test('trucks are crew-and-tool lanes, requests are jobs, the coverage rule is in words, lateness is against the target', () => {
    const model = supplyRunPlanned()
    const text = screen(model)
    for (const truck of model.inputs.resources) expect(text).toContain(truck.label)
    expect(text).toContain('Crews and tools')
    for (const job of model.inputs.jobs) expect(text).toContain(job.title)
    // U-1 on Truck 4 from 08:02 (when Truck 2 joins) to 08:02 + 150 s + 180 s = 08:07:30, in Oslo summer time (+2 h).
    expect(text).toContain('Thu 10:02–10:07:30')
    // R-1 on Truck 3 from 08:00 to 08:00 + 240 s + 180 s = 08:07.
    expect(text).toContain('Thu 10:00–10:07')
    // Lateness of the bulk request: 30 s past its 08:07 target, said as a goal value.
    expect(text).toContain('Least lateness of jobs tagged “bulk” past their target:')
    expect(text).toContain('30 s')
    expect(text).toContain('best found under budget')

    const rules = screen(model, 'rules')
    const rule = model.inputs.rules[0]!
    expect(rules).toContain(rule.words)
    expect(rules).toContain('At least 1 of 2 in service at all times: Truck 2, Truck 4.')
    expect(rules).toContain('Keep in service')

    const crews = screen(model, 'crews')
    expect(crews).toContain('Payload 1,500 kg · configured · read Thu 10:00')
    // Truck 2 and Truck 5 are announced, not in World: their payload is an assumption, marked by shape and word.
    expect(crews).toContain('△ Assumption')
    expect(crews).toContain('Payload 300 kg · configured · read Thu 10:00; 600 kg from Thu 10:03')

    const work = screen(model)
    // World-sourced durations show their basis and read time and the check-it warning.
    expect(work).toContain('5 min 30 s · owner estimate · read Thu 10:00')
    expect(work).toContain('check it describes the work')
  })

  test('times the screen writes itself are in the plan zone', () => {
    const crews = screen(supplyRunPlanned(), 'crews')
    // Truck 2 joins at 08:02 UTC, which is 10:02 in Oslo summer time; the screen says 10:02.
    expect(crews).toContain('Thu 10:02–10:30')
    expect(crews).toContain('Thu 10:05:30–10:30')
  })

  // The fixture's own labels and notes still mix the Scenario clock and cue ids ("Joins at 08:02",
  // "cue second-truck, 120 s"). maint and lane A are rewriting them in plan-zone time. Until that lands
  // this check is expected to fail; when it starts to pass, turn test.failing into test.
  test.failing('the crews view, counting authored text too, shows no ids, JSON or seconds counts', () => {
    const model = supplyRunPlanned()
    expect(routineBreaches(screen(model, 'crews'), identifiers(model.inputs), [])).toEqual([])
  })

  test('routine views show no ids, JSON or seconds counts', () => {
    for (const model of [modelOf(supplyRunInputs()), supplyRunPlanned()]) {
      for (const view of views) {
        expect({ view, breaches: routineBreaches(screen(model, view), identifiers(model.inputs), labelsOf(model)) }).toEqual({ view, breaches: [] })
      }
    }
  })
})
