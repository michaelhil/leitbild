// One test per screen item from maint's fourth walk (maint/walk-inc1-r4.md), named by screenshot id.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'svelte'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createPlanningClient } from './api.ts'
import { finishChain, mostLimiting, partsText, type ExplainResult } from './explain-text.ts'
import { modelOf, runBasis, status, supplyRunPlanned, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, durationText } from './format.ts'
import { createNames, needsText, type PlanModel } from './model.ts'
import type { Preview } from './preview.ts'
import { statusView, type Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: FinishPanel } = await import('./FinishPanel.svelte') as { default: Any }
const { default: EditPreview } = await import('./EditPreview.svelte') as { default: Any }
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }
const { default: WorkList } = await import('./WorkList.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}

describe("maint's fourth walk, screen items", () => {
  test('N4-1-01, N4-1-02 (R4-3): one word per goal, the gap only when positive, one line on how the search ended', () => {
    const model = supplyRunPlanned()
    const run = runBasis(model.inputs.settings.grid)
    // A best-found goal with its bound equal to the value (the goal-order rule keeps it from "proven optimal").
    const view = statusView(status({ word: 'validated feasible', run, goals: [
      { word: 'best found under budget', goal: 0, value: 2, unit: 'min', bound: { value: 1.5, source: 'logic+calendars' } },
      { word: 'best found under budget', goal: 1, value: 0, unit: 'min', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } },
    ] }), contextOf(model))
    // Walk V11 (increment 2): the bound itself, never "could be up to X better".
    expect(view.goals.map(goal => [goal.mark.word, goal.distance])).toEqual([['best found', 'no plan has less than 1 min 30 s of lateness'], ['best found', '']])
    expect(view.run).toBe('The search ran to the end.')
    const early = statusView(status({ word: 'validated feasible', run: { ...run, stoppedBy: 'memory' }, goals: [] }), contextOf(model))
    expect(early.run).toBe('The search stopped early: it reached the memory it may use.')
    const text = readableText(renderHtml(PlanScreen, { client: createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('offline') }), planId: model.id, initial: model, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))
    expect(text).not.toContain('best possible')
    expect(text).not.toContain('under budget')
  })

  test('N4-3-01: a job any one truck can do reads "Truck 1 or Truck 3"', () => {
    const model = supplyRunPlanned()
    const names = createNames(model.inputs)
    expect(needsText([{ anyOf: ['truck-1', 'truck-3'], amount: 1 }], names.resource)).toBe('Truck 1 or Truck 3')
    expect(needsText([{ anyOf: ['truck-1'], amount: 1 }, { anyOf: ['truck-3', 'truck-4'], amount: 2 }], names.resource)).toBe('Truck 1 and 2 of Truck 3 or Truck 4')
    const unplanned = modelOf(model.inputs)
    const list = readableText(renderHtml(WorkList, { context: contextOf(unplanned), rows: [], onSelect: none }))
    expect(list).toContain('Truck 1, Truck 2, Truck 3, Truck 4 or Truck 5 (hired)')
  })

  test('SR-02 (R4-4): durations never show fractional seconds; they read at the plan\'s step', () => {
    expect(durationText(209.8, 's')).toBe('3 min 30 s')
    expect(durationText(29.8, 's')).toBe('30 s')
  })

  test('N-D-01, N4-4-01 (R4-4): links are inline text, and a rule link holds its own quote marks', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const rows = model.rows['opt-1']!
    const result: ExplainResult = { lines: [], items: [{ job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: false, because: [{ kind: 'span-limit', about: [{ kind: 'rule', key: 'R2' }] }] }] }
    const html = renderHtml(FinishPanel, { steps: finishChain(result, context), limiting: mostLimiting(result, context), onPick: none, onClose: none })
    expect(html).not.toContain('class="link name"')
    expect(html.replace(/<!--[\s\S]*?-->/g, '')).toMatch(/past <a class="name quiet" href="#item-rule-R2">“[^<]+”<\/a>/)
  })

  test('T0s-05, R3-7-01 (R4-4): "Not saved" once; "1 job"; the Align preview names the new dates', () => {
    const model = trainAPlanned()
    const write = { plan: { id: model.id, title: model.title, revision: 3 }, target: { kind: 'resource' as const, ref: workspaceResourceReferenceSchema.parse({ workspaceId: '0b4b9a52-2f7e-4c1a-9d3e-00000000000a', moduleId: 'planning', type: 'planning.plan', id: model.id }) }, changed: [], attention: [], problems: [] }
    const preview: Preview = { label: 'Align the window to the simulation: Thu 3 Sep 10:00 to Thu 3 Sep 10:30', refusal: null, asks: null, result: { ...write, preview: { saved: false, consequence: 'Not saved. The window moves.', violations: [], weakens: [] } } }
    const text = readableText(renderHtml(EditPreview, { preview, context: contextOf(model), onApply: none, onDiscard: none, onUseTime: none }))
    expect(text.match(/Not saved/g)?.length).toBe(1)
    expect(text).toContain('Preview: Align the window to the simulation: Thu 3 Sep 10:00 to Thu 3 Sep 10:30')
    const one = { ...model.inputs, jobs: model.inputs.jobs.slice(0, 1), links: [] }
    const single: PlanModel = { ...modelOf(one), certifiedSize: { decided: true, family: 'single-train work weeks', maxJobs: 33, evidence: 'measured 11 Nov', limitJobs: 60 } }
    const screen = readableText(renderHtml(PlanScreen, { client: createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('offline') }), planId: single.id, initial: single, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))
    expect(screen).toContain('Plan size: 1 job · certified up to 33')
  })

  test('R4-4: every form starts empty after an applied change (the forms are keyed on the count of applied changes)', () => {
    const source = readFileSync(join(import.meta.dir, 'PlanScreen.svelte'), 'utf8')
    for (const form of ['JobForm', 'CrewForm', 'RulesPanel', 'JobPanel']) expect(source).toMatch(new RegExp(`\\{#key applied\\}\\s*<${form} `))
    // The World picker is not reset: it keeps its search and results, so three trucks take one search (walk 5, R4-4-03).
    expect(source).not.toMatch(/\{#key applied\}\s*<EquipmentPicker /)
    expect(source).toContain('applied += 1')
  })

  test('T7-01, T0s-10 (R4-1): the "Most limiting" line says hours only when checked, "no gain" only when checked, and neither when not computed', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const rows = model.rows['opt-1']!
    const items: ExplainResult['items'] = [
      { job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: false, because: [{ kind: 'link', about: [{ kind: 'job', key: 'SWA-PUMP-OUT' }] }] },
      { job: 'SWA-PUMP-OUT', start: rows[1]!.start, finish: rows[1]!.finish, floatHours: 0, joint: false, because: [{ kind: 'shift', about: [{ kind: 'resource', key: 'ect-team' }], until: rows[1]!.start }] },
    ]
    const about = { kind: 'resource' as const, key: 'mech-station' }
    const line = (result: ExplainResult) => {
      const limiting = mostLimiting(result, context)
      const rendered = readableText(renderHtml(FinishPanel, { steps: finishChain(result, context), limiting, onPick: none, onClose: none }))
      return { words: partsText(limiting!.parts), rendered }
    }
    const waits = 'Most limiting: the finish waits on Pull SW A pump assembly: Eddy-current test contractor is not on shift before Tue 07:00.'
    // Checked, with a gain (a hand value standing in for lane S's answer): the resource and the hours.
    const gain = line({ lines: [], items, limiting: { result: 'gain', about, hoursEarlier: 1 } })
    expect(gain.words).toBe('Most limiting: Station mechanical crew. One more Station mechanical crew would allow a finish at least 1 h earlier.')
    expect(gain.rendered).toContain('would allow a finish at least 1 h earlier.')
    // Checked, no gain (the flagship): what the finish waits for, and only this plan is spoken of.
    const noGain = line({ lines: [], items, limiting: { result: 'no-gain', about } })
    expect(noGain.words).toBe(`${waits} One more Station mechanical crew alone does not bring it earlier in this plan.`)
    expect(noGain.rendered).toContain('alone does not bring it earlier in this plan.')
    expect(noGain.words).not.toMatch(/never|could not|earlier\./)
    // Not computed (the solver was busy, or nothing to check): the binding cause, and nothing more.
    const notComputed = line({ lines: [], items })
    expect(notComputed.words).toBe(waits)
    for (const text of [notComputed.words, notComputed.rendered]) expect(text).not.toMatch(/one more|h earlier|does not bring/i)
  })
})
