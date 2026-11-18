// T0 "Start my own plan from empty" (maint/tasks.md) on both cases, driven through the plan screen's own
// action sequence (ui/plan-actions.ts), its own form builders (ui/edit-forms.ts) and its own preview card
// (EditPreview.svelte, rendered) against real World, Host and Planning: from an empty plan to a validated
// feasible plan. Walk 2 (R2-1, R2-2) stopped at two dead ends that only this sequence shows: a World truck
// refused as "no longer in this plan", and drafted tag-outs and tests with no way to name their crew.
import { afterAll, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import type { ModuleDefinitionDescriptor, PlanningSubject } from '@leitbild/contracts'
import { createPlanningClient } from '../../../apps/planning/src/ui/api.ts'
import { createPlanActions, type Shown } from '../../../apps/planning/src/ui/plan-actions.ts'
import { alignWindowEdit, crewEdit, crewEdits, equipmentFromWorld, simulationNow, goalsEdit, jobEdits, linkEdit, localInputValue, planEdits, resourceFromWorld, ruleEdit, type GoalChoice } from '../../../apps/planning/src/ui/edit-forms.ts'
import { readableText, registerSvelte, renderHtml } from '../../../apps/planning/src/ui/fixtures/svelte-ssr.ts'
import { createTimeFormat } from '../../../apps/planning/src/ui/format.ts'
import { createNames } from '../../../apps/planning/src/ui/model.ts'
import type { Preview } from '../../../apps/planning/src/ui/preview.ts'
import type { Edit } from '../../../apps/planning/src/plan/edit-schema.ts'
import type { Weekday } from '../../../apps/planning/src/time/zone.ts'
import { createPlanningStack } from './planning-stack.ts'

registerSvelte()
const { default: EditPreview } = await import('../../../apps/planning/src/ui/EditPreview.svelte') as { default: Component<Record<string, unknown>> }
const stack = await createPlanningStack()
afterAll(() => stack.close())

const client = createPlanningClient(stack.workspaceId, (input, init) => fetch(`${stack.hostUrl}${String(input)}`, init))
const built = (result: { ok: true; edits: readonly Edit[] } | { ok: false; problems: readonly string[] }): readonly Edit[] => {
  if (!result.ok) throw new Error(`The form refused: ${result.problems.join(' ')}`)
  return result.edits
}
const falseName = /no longer in this plan/

/** The Library's "New plan" form: create with the name, zone and window, then the goals in the plan's currency. */
const createFromEmpty = async (form: { title: string; windowStart: string; windowEnd: string; goals: GoalChoice[]; grid: '30min' | '30s' }): Promise<string> => {
  const blank = (await client.definitions()).definitions.find(entry => entry.ref.id === 'blank') as ModuleDefinitionDescriptor
  const first = built(planEdits({ ...form, timeZone: 'Europe/Oslo' }))
  const created = await client.create(blank, [first[0]!], form.grid)
  const plan = created.result.plan
  const summary = (await client.read(plan.id, { section: 'summary' })).sections[0]!.data as { settings: { currency: string } }
  await client.edit(plan.id, plan.revision, { edits: [...built(goalsEdit(form.goals, summary.settings.currency))] })
  return plan.id
}

/** The preview card as a person reads it: it offers Apply, refuses nothing, and names only what the plan will have. */
const card = (shown: Shown, preview: Preview, pending: readonly Edit[]): string => {
  const context = { inputs: shown.model.inputs, names: createNames(shown.model.inputs), format: createTimeFormat(shown.model.inputs.settings.timeZone) }
  const none = () => {}
  return readableText(renderHtml(EditPreview, { preview, pending, context, onApply: none, onDiscard: none, onUseTime: none, onAddEdits: none }))
}

/**
 * One planner step: preview, then Apply. The preview of a valid edit is never a refusal, and nothing it
 * says names an item the plan does not have. A crew is named for every job the preview shows without one
 * (the drafted tag-outs and tests), with the card's own "Who does it" edit appended to the same list (R2-2).
 */
const step = async (actions: ReturnType<typeof createPlanActions>, shown: Shown, edits: readonly Edit[], label: string, crew?: string): Promise<Shown> => {
  let list = [...edits]
  let preview = await actions.preview(shown.model, list, label)
  const read = (text: string) => {
    expect([label, text.includes('Refused'), falseName.test(text), text.includes('Apply')]).toEqual([label, false, false, true])
    return text
  }
  read(card(shown, preview, list))
  expect([label, preview.refusal]).toEqual([label, null])
  const uncrewed = (preview.result?.problems ?? []).filter(problem => problem.code === 'no-crew').map(problem => problem.about[0]!)
  if (crew !== undefined && uncrewed.length > 0) {
    expect(read(card(shown, preview, list))).toContain('Who does it')
    list = [...list, ...uncrewed.flatMap(key => built(crewEdit(key, crew)))]
    preview = await actions.preview(shown.model, list, label)
    read(card(shown, preview, list))
    expect([label, preview.refusal]).toEqual([label, null])
    expect(preview.result!.problems.filter(problem => problem.code === 'no-crew')).toEqual([])
  }
  const next = await actions.apply(shown.model, list, null, null, label)
  expect(next.model.revision).toBeGreaterThan(shown.model.revision)
  return next
}

const unread = (shown: Shown) => shown.model.attention.filter(item => /not read yet/.test(item.text))

/**
 * T0 on the Supply run through the screen. With `align`, the plan keeps the Library form's own default week
 * (12-17 Nov, nowhere near the simulation's Thu 3 Sep) and the planner uses the screen's "Align the window"
 * after adding the trucks: their whole-window availability moves with it (walk 3, R3-1, N-C-01..05).
 */
const supplyRunFromEmpty = async (window: { start: string; end: string }, align: boolean) => {
  const runId = await stack.start('world.scenario', 'supply-run', 'world.scenario.start')
  const planId = await createFromEmpty({ title: 'Supply run from empty', windowStart: window.start, windowEnd: window.end, goals: ['finish'], grid: '30s' })
  const actions = createPlanActions(client, planId)
  let shown = await actions.load(null)
  shown = await actions.link(shown.model, runId, null)
  expect(shown.notice).toMatch(/World values read/)

  // Three trucks from World, each as a tool (walk 2 D2-01..03): previewed, saved, and their values read at once.
  const trucks = (await actions.search(shown.model, 'truck')).slice(0, 3)
  expect(trucks.length).toBe(3)
  for (const truck of trucks) {
    const calendar = shown.model.inputs.calendars[0]?.key ?? ''
    shown = await step(actions, shown, built(resourceFromWorld(truck, { kind: 'tool', calendar }, shown.model.inputs)), `Add ${truck.label} as a tool`)
    expect(unread(shown)).toEqual([])
    // A value no job uses is never a readiness problem (walk 3, R3-2, N-B-01).
    expect(shown.model.attention.filter(item => /cannot use|not read yet/.test(item.text))).toEqual([])
  }
  const truckKeys = shown.model.inputs.resources.filter(resource => resource.locator !== undefined).map(resource => resource.key)
  expect(truckKeys).toHaveLength(3)

  if (align) {
    const simulated = simulationNow(shown.model.inputs)!
    shown = await step(actions, shown, built(alignWindowEdit(shown.model.inputs, simulated)), 'Align the window to the simulation')
    const aligned = shown.model.inputs.settings.window!
    expect(Date.parse(aligned.start) <= Date.parse(simulated) && Date.parse(simulated) < Date.parse(aligned.end)).toBe(true)
    const availability = shown.model.inputs.resources.filter(resource => truckKeys.includes(resource.key)).map(resource => shown.model.inputs.calendars.find(calendar => calendar.key === resource.calendar)!.periods)
    expect(availability).toEqual(truckKeys.map(() => [aligned]))
  }

  // One crew with its own shift; three jobs with the planner's own estimates; one link; one rule in words.
  shown = await step(actions, shown, built(crewEdits({ label: 'Dispatcher', kind: 'crew', count: '1', crewSize: '', calendar: '', days: ['thu'] as Weekday[], from: '10:00', to: '12:00', sourceBy: 'planner', sourceNote: '' }, shown.model.inputs)), 'Add the dispatcher')
  const dispatcher = shown.model.inputs.resources.find(resource => resource.label === 'Dispatcher')!.key
  const job = (title: string, minutes: string, crews: readonly string[]) => built(jobEdits({ title, kind: 'work', equipment: [], inside: false, value: minutes, unit: 'min', elapsed: false, low: '', high: '', sourceBy: 'planner', sourceNote: '', crews, amount: '1', continuous: true }, shown.model.inputs))
  shown = await step(actions, shown, job('Plan the route', '10', [dispatcher]), 'Add a job')
  shown = await step(actions, shown, job('Deliver water to the sports hall', '20', truckKeys), 'Add a job')
  shown = await step(actions, shown, job('Deliver food to the field kitchen', '15', truckKeys), 'Add a job')
  const [route, water] = ['Plan the route', 'Deliver water to the sports hall'].map(title => shown.model.inputs.jobs.find(entry => entry.title === title)!.key)
  shown = await step(actions, shown, built(linkEdit({ from: route!, to: water!, type: 'FS', lag: '', lagUnit: 'min' })), 'Add a link')
  shown = await step(actions, shown, built(ruleEdit({ kind: 'keep-in-service', words: 'Keep at least one truck free at all times.', sourceBy: 'planner', sourceNote: '', equipment: [], members: [truckKeys[0]!, truckKeys[2]!], atLeast: '1', group: '', limit: '', limitUnit: 'h', job: '', finishBy: '' }, shown.model.inputs)), 'Add a rule')

  const generated = await actions.generate(shown.model, {}, new AbortController().signal, null)
  console.log(`T0 Supply run${align ? ', aligned' : ''}:`, generated.error, JSON.stringify(generated.model.options?.items.map(item => item.status.word)))
  expect(generated.error).toBeNull()
  const recommended = generated.model.options!.items.find(item => item.key === generated.model.options!.recommended)!
  expect([recommended.status.word, recommended.fresh]).toEqual(['validated feasible', true])
}

test('T0 Supply run from empty, through the screen: three World trucks, a crew, jobs, a link and a rule, generated validated feasible', async () => {
  // The simulation's day, Thu 3 Sep, on the 30 s step.
  await supplyRunFromEmpty({ start: '2026-09-03T10:00', end: '2026-09-03T12:00' }, false)
}, 240_000)

test('T0 Supply run from the default week, aligned to the simulation through the screen: the trucks go with the window (walk 3, R3-1)', async () => {
  await supplyRunFromEmpty({ start: '2026-11-12T07:00', end: '2026-11-17T07:00' }, true)
}, 240_000)

test('T0 plant from empty, through the screen: two World pumps, a crew, jobs with drafted brackets crewed in the preview, a link and a rule', async () => {
  const runId = await stack.start('world.scenario', 'train-a-work-week', 'world.scenario.start')
  // The plan week Train A plans for, Mon 07:00 to Sat 07:00 in the plant's zone.
  const planId = await createFromEmpty({ title: 'Pump work from empty', windowStart: localInputValue('2026-11-16T06:00:00Z', 'Europe/Oslo'), windowEnd: localInputValue('2026-11-21T06:00:00Z', 'Europe/Oslo'), goals: ['finish'], grid: '30min' })
  const actions = createPlanActions(client, planId)
  let shown = await actions.load(null)
  shown = await actions.link(shown.model, runId, null)

  // Two pumps from World, as equipment.
  const found = await actions.search(shown.model, 'service water pump')
  const pumps: PlanningSubject[] = found.slice(0, 2)
  console.log('T0 plant pumps:', pumps.map(pump => pump.label))
  expect(pumps).toHaveLength(2)
  for (const pump of pumps) {
    shown = await step(actions, shown, built(equipmentFromWorld(pump, { group: '', newGroup: '' }, shown.model.inputs)), `Add ${pump.label}`)
    expect(unread(shown)).toEqual([])
  }
  const [pumpA, pumpB] = pumps.map(pump => shown.model.inputs.equipment.find(item => item.locator === pump.locator)!.key)

  // One crew with a day shift, then the work on each pump: its tag-out and test are drafted, and their crew named in the same preview.
  shown = await step(actions, shown, built(crewEdits({ label: 'Mechanical crew', kind: 'crew', count: '1', crewSize: '', calendar: '', days: ['mon', 'tue', 'wed', 'thu', 'fri'] as Weekday[], from: '07:00', to: '19:00', sourceBy: 'planner', sourceNote: '' }, shown.model.inputs)), 'Add the crew')
  const crew = shown.model.inputs.resources.find(resource => resource.label === 'Mechanical crew')!.key
  const work = (title: string, item: string) => built(jobEdits({ title, kind: 'work', equipment: [item], inside: true, value: '6', unit: 'h', elapsed: false, low: '', high: '', sourceBy: 'planner', sourceNote: '', crews: [crew], amount: '1', continuous: false }, shown.model.inputs))
  shown = await step(actions, shown, work('Replace the seal on pump A', pumpA!), 'Add work on pump A', crew)
  shown = await step(actions, shown, work('Replace the seal on pump B', pumpB!), 'Add work on pump B', crew)
  expect(shown.model.inputs.jobs.filter(entry => entry.kind !== 'work').map(entry => [entry.kind, entry.needs.flatMap(need => need.anyOf)])).toEqual([['tag-out', [crew]], ['test', [crew]], ['tag-out', [crew]], ['test', [crew]]])
  const [sealA, sealB] = ['Replace the seal on pump A', 'Replace the seal on pump B'].map(title => shown.model.inputs.jobs.find(entry => entry.title === title)!.key)
  shown = await step(actions, shown, built(linkEdit({ from: sealA!, to: sealB!, type: 'FS', lag: '', lagUnit: 'h' })), 'Add a link')
  shown = await step(actions, shown, built(ruleEdit({ kind: 'keep-in-service', words: 'One of the two service water pumps always in service.', sourceBy: 'planner', sourceNote: '', equipment: [], members: [pumpA!, pumpB!], atLeast: '1', group: '', limit: '', limitUnit: 'h', job: '', finishBy: '' }, shown.model.inputs)), 'Add a rule')

  const generated = await actions.generate(shown.model, {}, new AbortController().signal, null)
  console.log('T0 plant:', generated.error, JSON.stringify(generated.model.options?.items.map(item => item.status)))
  expect(generated.error).toBeNull()
  const recommended = generated.model.options!.items.find(item => item.key === generated.model.options!.recommended)!
  expect([recommended.status.word, recommended.fresh]).toEqual(['validated feasible', true])
}, 240_000)
