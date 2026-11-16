// The demo layout pass (impl/inc1/demo-layout-pass.md), one test per item. Layout and wording only: the
// data, the operations and the status rules are the ones the walks scored.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'svelte'
import { jobsPerSolve, sizeCautionWarning } from '../plan/summary.ts'
import { createPlanningClient } from './api.ts'
import { attentionCards } from './attention.ts'
import { addedAs } from './edit-forms.ts'
import { causeText, finishChain, mostLimiting, partsText, stepParts, whyStart, type ExplainResult } from './explain-text.ts'
import { hourMs, modelOf, optionOf, runBasis, status, supplyRunPlanned, trainAPlanned, trainARows } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, hoursText } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import { optionsGlance } from './options-glance.ts'
import { refusalLine, refusalProof } from './outcome.ts'
import { planSizeLine } from './size-text.ts'
import { goalName, goalOrderShort, goalShort, statusLegend, statusView, type Context } from './status-text.ts'
import { layoutTimeline } from './timeline-layout.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: AttentionColumn } = await import('./AttentionColumn.svelte') as { default: Any }
const { default: FinishPanel } = await import('./FinishPanel.svelte') as { default: Any }
const { default: OptionsGlance } = await import('./OptionsGlance.svelte') as { default: Any }
const { default: PlanHeader } = await import('./PlanHeader.svelte') as { default: Any }
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }
const { default: RulesPanel } = await import('./RulesPanel.svelte') as { default: Any }
const { default: StatusBlock } = await import('./StatusBlock.svelte') as { default: Any }
const { default: Timeline } = await import('./Timeline.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const source = (name: string): string => readFileSync(join(import.meta.dir, name), 'utf8')
const css = /<style>([\s\S]*)<\/style>/.exec(source('App.svelte'))?.[1] ?? ''
const plain = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '')
const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const screenOf = (model: PlanModel): string => renderHtml(PlanScreen, { client: offline, planId: model.id, initial: model, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none })

/**
 * The Module's refusal of the flagship's "days only, swap" option, as explain (ask refusal) gave it on the
 * local stack on 15 Nov. A TEST INPUT standing in for that answer: the screen only gives it its form.
 */
const spanRefusal = [
  'Not possible: Once the first Train A cooling item is tagged out, every item in the chain must be back and tested within 72 h, in one continuous span. Station policy allows one entry per window.',
  'The shortest span this plan allows is 80.5 h, against 72 h: first tag-out Mon 11:00, last test passed Thu 19:30.',
  'What sets the last test, each job at its earliest:',
  '- Remove SW A from service and hang tags: Mon 11:00 to Mon 14:00, unbroken',
  '- Restore SW A, fill and vent, pump test: Thu 11:00 to Thu 14:30, unbroken',
]
const spanCause = { kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }, { job: 'SWA-PUMP-OUT', via: 'link' }, { job: 'SWA-RTS', via: 'link' }] }

/** Train A with its hand-placed option and a second, refused one. */
const twoOptions = (refusals: PlanModel['refusals']): PlanModel => {
  const planned = trainAPlanned()
  const rows = trainARows(planned.inputs)
  // The chain's span in the hand-placed option: first tag-out start to last test finish (32.5 h, see plans.ts).
  const span = (Date.parse(rows[2]!.finish) - Date.parse(rows[0]!.start)) / hourMs
  const feasible = { ...planned.options!.items[0]!, label: 'Swap in refurbished spare', metrics: [{ id: 'goal:0:COOL-A', value: span, unit: 'h' }] }
  const refused = optionOf('opt-2', 'Swap in refurbished spare, days only', status({ word: 'proven infeasible', cause: spanCause, run: runBasis(planned.inputs.settings.grid) }))
  return { ...planned, options: { ...planned.options!, items: [feasible, refused] }, refusals }
}

describe('demo layout pass', () => {
  test('1. at 1280 px and wider there are three columns, and every answer opens in the right one', () => {
    expect(css).toMatch(/\.screen-grid \{ display: grid; grid-template-columns: 300px minmax\(0, 1fr\) 360px;[^}]*grid-template-areas: "attention views views" "attention main panel";/)
    // Below 1280 px the detail column stacks under the other two, as before.
    expect(css).toMatch(/@media \(max-width: 1279px\) \{\s*\.screen-grid, \.screen-grid\.no-detail \{ grid-template-columns: 300px minmax\(0, 1fr\);[^}]*"panel panel"; \}/)
    // The finish chain, the job panel and the previews are in the detail column; the attention column holds cards only.
    const screen = source('PlanScreen.svelte')
    const detail = screen.slice(screen.indexOf('<div class="col-panel"'))
    for (const panel of ['<EditPreview ', '<JobPanel ', 'finishPanel()', 'optionDetail()']) expect(detail).toContain(panel)
    expect(screen.slice(screen.indexOf('<div class="col-attention">'), screen.indexOf('<nav class="views"'))).not.toMatch(/FinishPanel|JobPanel|EditPreview/)
    const model = trainAPlanned()
    const context = contextOf(model)
    const row = model.rows['opt-1']![2]!
    const result: ExplainResult = { lines: [], items: [{ job: 'SWA-RTS', start: row.start, finish: row.finish, floatHours: 0, joint: false, because: [{ kind: 'link', about: [{ kind: 'job', key: 'SWA-PUMP-OUT' }] }] }] }
    const left = readableText(renderHtml(AttentionColumn, { cards: attentionCards(model, context), finish: finishChain(result, context), limiting: null, onAction: none }))
    expect(left).not.toContain('Pull SW A pump assembly')
    expect(readableText(renderHtml(FinishPanel, { steps: finishChain(result, context), onPick: none, onClose: none }))).toContain('What sets the finish')
  })

  test('2. the header is compact: one Generate toolbar, one context line, one plan-size line', () => {
    const model = trainAPlanned()
    const jobs = jobsPerSolve(model.inputs)
    const size = (maxJobs: number, limitJobs: number, decided = true) => ({ decided, family: 'one system window', maxJobs, limitJobs, evidence: 'Measured 11 Nov on single-train work weeks.' })
    // The three bands, placed around this fixture's own job count.
    expect(planSizeLine(size(jobs, jobs + 7), model.inputs)).toBe(`Plan size: ${jobs} jobs · certified up to ${jobs}, handles up to ${jobs + 7} with a caution`)
    expect(planSizeLine(size(jobs - 1, jobs), model.inputs)).toBe(`Plan size: ${jobs} jobs · certified up to ${jobs - 1}, handles up to ${jobs} with a caution · this plan is above the certified size: its options carry the caution`)
    expect(planSizeLine(size(jobs - 2, jobs - 1), model.inputs)).toBe(`Plan size: ${jobs} jobs · certified up to ${jobs - 2}, handles up to ${jobs - 1} with a caution · this plan is too large to generate`)
    expect(planSizeLine(size(jobs, jobs, false), model.inputs)).toBe(`Plan size: ${jobs} jobs · certified size pending the owner's decision, measured up to ${jobs}`)
    // The decided numbers: 33 certified, 40 with a caution.
    const html = plain(renderHtml(PlanHeader, { context: contextOf(model), title: model.title, size: { line: planSizeLine(size(33, 40), model.inputs), evidence: 'Measured 11 Nov.' }, onGenerate: none, onCancel: none }))
    const text = readableText(html)
    expect(text).toContain(`Plan size: ${jobs} jobs · certified up to 33, handles up to 40 with a caution`)
    expect(text).not.toMatch(/in one solve|system window/)
    // The method choice, "Days only" and Generate are one toolbar; window, now and time zone one line.
    const toolbar = /<div class="generate"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
    for (const part of [model.inputs.methods[0]!.label, 'Let Generate choose', 'Days only', '>Generate</button>']) expect(toolbar).toContain(part)
    expect(readableText(/<div class="context-line hint"><span>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? '')).toMatch(/^\s*Window .* · Now .* · Times in Europe\/Oslo\s*$/)
    expect(html).toMatch(/<details class="size-evidence"><summary>How the size was measured<\/summary><p>Measured 11 Nov\.<\/p><\/details>/)
  })

  test('3. the options are compared in one table above the timeline; a refused option says "Not possible" with its hours', () => {
    const model = twoOptions({ 'opt-2': spanRefusal })
    const context = contextOf(model)
    const glance = optionsGlance(model, context)!
    expect(glance.columns).toEqual(['Longest outage', 'Over the 54 h guideline', 'Extra cost', 'Equipment-hours out of service'])
    const limit = model.inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === 'COOL-A')!
    const rows = trainARows(model.inputs)
    const out = `${hoursText((Date.parse(rows[2]!.finish) - Date.parse(rows[0]!.start)) / hourMs)} of ${limit.kind === 'span-limit' ? hoursText(limit.limit.value) : ''}`
    expect(out).toBe('32.5 h of 72 h')
    // The fixture's option reports two of the three goals; a goal it has no value for is an empty cell.
    expect(glance.rows[0]).toMatchObject({ label: 'Swap in refurbished spare', recommended: true, cause: null, cells: [{ value: out, mark: null }, { value: '0 h', mark: { word: 'proven optimal' } }, { value: 'NOK 0', mark: { word: 'best found' } }, null] })
    // One short line: the Module's sentence with the hours, without the detail after its colon.
    expect(glance.rows[1]).toMatchObject({ recommended: false, cells: null, cause: 'Not possible: The shortest span this plan allows is 80.5 h, against 72 h.' })
    const html = renderHtml(OptionsGlance, { glance, selected: 'opt-1', onSelect: none })
    const text = readableText(html)
    for (const part of ['Longest outage', '32.5 h of 72 h', '★ Recommended', '✓ validated feasible', '✕ proven infeasible', 'Not possible: The shortest span this plan allows is 80.5 h, against 72 h']) expect(text).toContain(part)
    // A row is chosen by its name, a button; the row shown is marked.
    expect(plain(html)).toMatch(/<tbody class="[^"]*selected[^"]*"/)
    expect(plain(html)).toMatch(/<button type="button" class="link option-name"[^>]*title="Show on the timeline"[^>]*>Swap in refurbished spare, days only<\/button>/)
    // It sits above the timeline on the Schedule view; the Options view keeps the detail.
    const screen = plain(screenOf(model))
    expect(screen.indexOf('class="options-glance"')).toBeGreaterThan(-1)
    expect(screen.indexOf('class="options-glance"')).toBeLessThan(screen.indexOf('class="timeline"'))
    expect(routineBreaches(text, ['opt-1', 'opt-2', 'COOL-A', 'SWA-TAG'], [])).toEqual([])
    // Without the Module's refusal lines the row still gives the proof, and never repeats "held by a link".
    const bare = optionsGlance(twoOptions({}), context)!.rows[1]!.cause!
    expect(bare).toBe('Not possible: The times cannot line up along this chain: Remove SW A from service and hang tags (held by an outage limit), then Pull SW A pump assembly, then Restore SW A, fill and vent, pump test.')
  })

  test('4. the timeline comes first: each equipment row carries its jobs as bars, and the views sit on one row', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const layout = layoutTimeline(model.inputs, model.rows['opt-1']!, context.format)!
    const swa = layout.availability[0]!.items.find(item => item.label === context.names.equipment('SWA'))!
    // The three hand-placed jobs are all on SW A and follow one another, so its row needs one level.
    expect(swa.jobs.map(bar => [bar.key, bar.level])).toEqual([['SWA-TAG', 0], ['SWA-PUMP-OUT', 0], ['SWA-RTS', 0]])
    expect(swa.levels).toBe(1)
    expect(layout.otherJobs).toEqual([])
    // Two jobs on one item at the same time sit on two levels of its row.
    const together = model.rows['opt-1']!.map((row, index) => index === 1 ? { ...row, start: model.rows['opt-1']![0]!.start, finish: model.rows['opt-1']![0]!.finish } : row)
    const stacked = layoutTimeline(model.inputs, together, context.format)!.availability[0]!.items.find(item => item.label === context.names.equipment('SWA'))!
    expect([stacked.levels, stacked.jobs.map(bar => bar.level)]).toEqual([2, [0, 1, 0]])
    const html = plain(renderHtml(Timeline, { layout, onSelect: none }))
    expect(html).toMatch(/<div class="lane item-lane[^"]*"><span class="lane-label">Service Water Pump A<\/span>[\s\S]*?<button type="button" class="job-bar kind-tag-out[^"]*"[^>]*aria-label="Tag-out: Remove SW A from service and hang tags: Mon 07:00–10:00/)
    expect(html.indexOf('Availability and jobs')).toBeLessThan(html.indexOf('Crews and tools'))
    // A plan whose jobs are on no equipment (the Supply run) gives each job its own row.
    const supply = supplyRunPlanned()
    const trucks = layoutTimeline(supply.inputs, supply.rows['opt-1']!, contextOf(supply).format)!
    expect([trucks.availability.length, trucks.otherJobs.map(bar => bar.key)]).toEqual([0, ['R-1', 'U-1']])
    expect(css).toMatch(/\.views \{ display: flex; flex-wrap: nowrap;/)
    // The label column gives way before the track does: the day labels keep their room (380 px for the track).
    expect(css).toMatch(/\.lane, \.axis \{ display: grid; grid-template-columns: minmax\(150px, 200px\) minmax\(380px, 1fr\);/)
  })

  test('5. an explanation is a short list: the job as the only plain link, its time, one sentence; a refusal uses the same form', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const rows = model.rows['opt-1']!
    const until = rows[2]!.start
    // Two crews held by the same job until the same time are said once; a link is "follows".
    const waits: ExplainResult['items'][number] = { job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: true, because: [
      { kind: 'crew', about: [{ kind: 'resource', key: 'work-control' }, { kind: 'job', key: 'SWA-PUMP-OUT' }], until },
      { kind: 'crew', about: [{ kind: 'resource', key: 'test-team' }, { kind: 'job', key: 'SWA-PUMP-OUT' }], until },
    ] }
    const crews = `${context.names.resource('work-control')} and ${context.names.resource('test-team')}`
    expect(partsText(stepParts(waits, context))).toBe(`waits for ${crews}, busy with Pull SW A pump assembly until ${context.format.clock(until)}`)
    const follows: ExplainResult['items'][number] = { job: 'SWA-PUMP-OUT', start: rows[1]!.start, finish: rows[1]!.finish, floatHours: 0, joint: true, because: [
      { kind: 'link', about: [{ kind: 'job', key: 'SWA-TAG' }], until: rows[1]!.start },
      { kind: 'tool', about: [{ kind: 'resource', key: 'crane' }], until: rows[1]!.start },
    ] }
    expect(partsText(stepParts(follows, context))).toBe(`follows Remove SW A from service and hang tags; waits for ${context.names.resource('crane')}, in use until ${context.format.clock(rows[1]!.start)} (together)`)
    const result: ExplainResult = { lines: [], items: [waits, follows], limiting: { result: 'no-gain', about: { kind: 'resource', key: 'work-control' } } }
    const html = plain(renderHtml(FinishPanel, { steps: finishChain(result, context), limiting: mostLimiting(result, context), onPick: none, onClose: none }))
    // "Most limiting" comes first, in two sentences.
    expect(html.indexOf('class="limiting"')).toBeLessThan(html.indexOf('<ol class="chain">'))
    expect(partsText(mostLimiting(result, context)!.parts).split('. ').length).toBe(2)
    // In each row only the job is a plain link; the crews, tools and jobs in its sentence are quiet.
    const steps = html.slice(html.indexOf('<ol class="chain">')).split('<li>').slice(1)
    expect(steps.length).toBe(2)
    for (const step of steps) expect(step.match(/<a class="name" /g)?.length).toBe(1)
    expect(steps[0]).toMatch(/<a class="name" href="#item-job-SWA-RTS">Restore SW A, fill and vent, pump test<\/a><\/span> · <span class="when">Tue 12:00–15:30<\/span> · <span class="because">waits for <a class="name quiet"/)
    expect(css).toMatch(/a\.name\.quiet \{ [^}]*text-decoration: none; \}/)
    // A refusal: "Not possible: …" with its hours, then the jobs as rows; the proof never says "held by a link".
    const refused = twoOptions({ 'opt-2': spanRefusal })
    const proof = refusalProof(refused.refusals['opt-2'], contextOf(refused))!
    expect(proof.headline).toBe(`Not possible: ${refusalLine(spanRefusal)}`)
    expect(proof.parts.map(part => [part.text, part.steps.map(step => [step.name, step.detail, step.job])])).toEqual([
      ['Once the first Train A cooling item is tagged out, every item in the chain must be back and tested within 72 h, in one continuous span. Station policy allows one entry per window.', []],
      ['What sets the last test, each job at its earliest:', [['Remove SW A from service and hang tags', 'Mon 11:00 to Mon 14:00, unbroken', 'SWA-TAG'], ['Restore SW A, fill and vent, pump test', 'Thu 11:00 to Thu 14:30, unbroken', 'SWA-RTS']]],
    ])
    const block = readableText(renderHtml(StatusBlock, { view: statusView(refused.options!.items[1]!.status, contextOf(refused)), proof, onPick: none }))
    expect(block).toContain('Not possible: The shortest span this plan allows is 80.5 h, against 72 h')
    expect(block).toContain('Remove SW A from service and hang tags · Mon 11:00 to Mon 14:00, unbroken')
    expect(`${block} ${readableText(screenOf(refused))}`).not.toContain('held by a link')
  })

  test('6. goals have short names on the main screen; the full wording is said once, in Rules and goals', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    expect(model.inputs.goals.map(goal => goalShort(goal, context))).toEqual(['Over the 54 h guideline', 'Extra cost', 'Equipment-hours out of service'])
    expect(goalOrderShort(model.inputs.goals, context)[0]).toBe('1. Over the 54 h guideline')
    const full = goalName(model.inputs.goals[0]!, context)
    expect(full).toBe('time over the 54 h guideline for Train A cooling chain (SW A, CCW A and HX A, RHR A, HHSI A)')
    const schedule = readableText(screenOf(model))
    expect(schedule).toContain('Over the 54 h guideline: 0 h')
    expect(schedule).not.toContain(full)
    expect(readableText(renderHtml(PlanScreen, { client: offline, planId: model.id, initial: model, initialView: 'options', onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))).not.toContain(full)
    expect(readableText(renderHtml(RulesPanel, { context, onPreview: none })).split(full).length).toBe(2)
    // Two goals that would read the same also name their groups.
    const twice = { ...model.inputs, goals: [model.inputs.goals[0]!, { ...model.inputs.goals[0]!, scope: { groups: ['CS-A'] } }] }
    expect(goalShort(twice.goals[1]!, contextOf(modelOf(twice)))).toBe('Over the 54 h guideline (Containment spray train A)')
  })

  test('7. one quiet line says what the status words mean, beside the options', () => {
    expect(statusLegend).toEqual([
      { word: 'validated feasible', means: 'every hard rule was checked independently' },
      { word: 'proven optimal', means: 'it cannot be better' },
      { word: 'best found', means: 'the best the search found, with any proven gap shown' },
    ])
    const model = trainAPlanned()
    const legend = /<p class="legend">([\s\S]*?)<\/p>/.exec(plain(renderHtml(OptionsGlance, { glance: optionsGlance(model, contextOf(model))!, onSelect: none })))?.[1] ?? ''
    expect(readableText(legend).replace(/\s+/g, ' ').trim()).toBe('validated feasible : every hard rule was checked independently · proven optimal : it cannot be better · best found : the best the search found, with any proven gap shown')
  })

  test('8. a bound is said as a fact, for a cost and for a time goal alike (walk V11)', () => {
    const model = trainAPlanned()
    const view = statusView(status({ word: 'validated feasible', run: runBasis(model.inputs.settings.grid), goals: [
      // Hand values: 11 h against a bound of 7.5 h leaves 3.5 h.
      { word: 'best found under budget', goal: 0, value: 11, unit: 'h', bound: { value: 7.5, source: 'logic+calendars', certificate: { kind: 'least-span', spans: [{ group: 'COOL-A', hours: 61.5 }] } } },
      // Fixed costs of NOK 340,000 are in every plan: the bound itself is said.
      { word: 'best found under budget', goal: 1, value: 472650, unit: 'NOK', bound: { value: 340000, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 340000 }] } } },
    ] }), contextOf(model))
    // Walk V11 (increment 2): a time goal says its bound too, never "could be up to X better".
    expect(view.goals.map(goal => goal.distance)).toEqual(['no plan has less than 7.5 h over the 54 h guideline', 'no plan can cost less than NOK 340,000'])
    const text = readableText(renderHtml(StatusBlock, { view }))
    expect(text).toContain('≈ best found no plan can cost less than NOK 340,000')
    expect(text).not.toContain('NOK 132,650')
  })

  test('9. walk 6: a shift cause reads the calendar; a quoted rule ends its sentence once; World items in the plan are marked', () => {
    const supply = supplyRunPlanned()
    const context = contextOf(supply)
    // Truck 2 joins when its calendar's one period opens (the fixture's "joins" calendar): no time came with the cause.
    const truck = supply.inputs.resources.find(resource => resource.key === 'truck-2')!
    const joins = supply.inputs.calendars.find(calendar => calendar.key === truck.calendar)!.periods[0]!.start
    expect(causeText({ kind: 'shift', about: [{ kind: 'resource', key: 'truck-2' }] }, context, joins)).toBe(`Truck 2 is not on shift before ${context.format.clock(joins)}`)
    expect(context.format.clock(joins)).toBe('Thu 10:02')
    // A rule quoted whole already ends with its full stop: no second one after the quote mark.
    const rule = supply.inputs.rules.find(item => item.kind === 'keep-in-service')!
    expect(rule.words.endsWith('.')).toBe(true)
    const row = supply.rows['opt-1']![1]!
    const why = whyStart({ job: 'U-1', start: row.start, finish: row.finish, floatHours: 0, joint: false, because: [{ kind: 'availability', about: [{ kind: 'rule', key: rule.key }] }] }, context, row)
    expect(why.sentence).toBe(`It starts then because starting earlier would break “${rule.words}”`)
    expect(why.sentence).not.toMatch(/\.”\./)
    // The World picker marks what is already in the plan.
    const inPlan = supply.inputs.resources.find(resource => resource.locator !== undefined)!
    expect(addedAs(supply.inputs, inPlan.locator!)).toBe('a crew or tool')
    expect(addedAs(supply.inputs, 'einsatz/unit/unit%3Atruck-9')).toBeNull()
    expect(source('EquipmentPicker.svelte')).toContain(`{#if addedAs(context.inputs, subject.locator)}{' '}<MarkTag mark={{ shape: '✓', word: 'added' }} tone="good" />`)
  })

  test('walk 7 [05]: the newest answer is on top of the detail column, so "What sets the finish" never opens under an open job panel', () => {
    const screen = source('PlanScreen.svelte')
    const detail = screen.slice(screen.indexOf('<div class="col-panel"'))
    // Asked after a job or a preview opened, the finish chain is rendered above them; a job chosen from it goes back on top.
    expect(detail.indexOf('{#if finishOnTop}{@render finishPanel()}{/if}')).toBeGreaterThan(-1)
    expect(detail.indexOf('{#if finishOnTop}{@render finishPanel()}{/if}')).toBeLessThan(detail.indexOf('<EditPreview '))
    expect(detail.indexOf('{#if !finishOnTop}{@render finishPanel()}{/if}')).toBeGreaterThan(detail.indexOf('<JobPanel '))
    expect(screen).toMatch(/limiting = answer\.limiting; finishOnTop = true; reveal\('\.finish-panel'\)/)
    expect(screen).toMatch(/selectedJob = job\s+why = null\s+finishOnTop = false\s+reveal\('\.job-panel'\)/)
  })

  test('the size caution shows beside the status of each option that carries it', () => {
    const model = trainAPlanned()
    const size = { decided: true, family: 'one system window', maxJobs: 33, limitJobs: 40, evidence: 'Measured 11 Nov.' }
    const caution = sizeCautionWarning(size)
    const cautioned: PlanModel = { ...model, options: { ...model.options!, items: model.options!.items.map(option => ({ ...option, warnings: [caution] })) } }
    const context = contextOf(cautioned)
    expect(optionsGlance(cautioned, context)!.rows[0]).toMatchObject({ caution: caution.text, warnings: [] })
    // A chip beside the status word, in the comparison table and in the shown option's detail (walk 7).
    const html = plain(screenOf(cautioned))
    const chip = '<span class="mark mark-warning"[^>]*><span aria-hidden="true">!</span> Above the certified size</span>'
    expect(html).toMatch(new RegExp(`<span class="mark mark-good"><span aria-hidden="true">✓</span> validated feasible</span>\\s*<span class="mark mark-warning" title="${caution.text.replace(/[.()]/g, '\\$&')}"><span aria-hidden="true">!</span> Above the certified size</span>`))
    expect(html.match(new RegExp(chip, 'g'))?.length).toBe(2)
    // The Module's sentence is written out once, under the status in the detail.
    expect(html.split(`<p class="beside caution">${caution.text}</p>`).length).toBe(2)
    expect(caution.text).toContain('Above the certified size (33 jobs)')
  })
})
