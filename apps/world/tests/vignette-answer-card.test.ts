import { newWorkspaceId, type DisplayCardItem } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp } from '../src/core/model/index.ts'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { CARD_ALERTS } from '../src/features/displays/compose/card.ts'
import { composeVignette } from '../src/features/displays/compose/compose.ts'
import { blockRows, elementBlocks } from '../src/features/displays/compose/element-groups.ts'
import { FRAME_ROWS, type VignetteElement, type VignetteSection, type VignetteValue } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { answerNotices, resetSeen } from '../src/ui/embed/vignette/answer-notice.ts'
import { underTitle } from '../src/ui/embed/vignette/format.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// An answer's vignette on four-loop Halden five minutes into a loss of offsite power (plan v5 W7, W8.2): its card
// lists the subjects' readings before alerts, the subjects' own alerts first and, past readings, the worst three
// with a count of the rest; it writes a demand as the command it is; each line names its object once. Its view
// names the one object it is on, groups its values by element, and says why and when it was composed, and when the
// Run was reset or a model changed after it.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:answer-card' as ActorId, label: 'Answer card', role: 'operator' as const }
const plantId = 'plant:halden-1'

let registry: SimulationRunRegistry
let dataDir: string
let runtime: SimulationRunRuntime
let start: number
const play = (seconds: number) => runtime.runMaximumPace(new Date(start + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
const runNow = (): Promise<ViewRun> => displayRunOf(registry, runtime, person, new Set())
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-answer-card-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  runtime = await registry.create({ scenarioId: 'halden-offsite-power-restoration' })
  await runtime.setClock({ paused: true })
  start = Date.parse(runtime.snapshot().clock!.currentTime)
  await play(300)
}, 240_000)
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const compose = async (spec: unknown) => {
  const outcome = await composeVignette(await runNow(), displaySpecSchema.parse(spec))
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome
}
const isAlert = (item: DisplayCardItem): boolean => item.subject !== undefined && 'alertId' in item.subject
const refOf = (item: DisplayCardItem): string | undefined => item.subject !== undefined && 'ref' in item.subject ? String(item.subject.ref) : undefined

describe('an answer\'s card (W7.2)', () => {
  test('the subjects\' readings first, then their own alerts and at most three in all, the rest counted; each line names its object', async () => {
    const { card } = await compose({
      title: 'Unit 1 · SG A level and feed', question: 'How are SG A\'s level and feed after the trip?',
      subjects: [`${plantId}#SG-A-LVL-NR`, `${plantId}#AFW-A-FLOW`], views: [{ kind: 'values', signals: [`${plantId}#SG-A-LVL-NR`, `${plantId}#AFW-A-FLOW`] }],
    })
    const first = card.items.findIndex(isAlert)
    expect(card.items.slice(0, first).map(refOf)).toEqual([`${plantId}#sgA.levelPercent`, `${plantId}#aux-feedwater-valve-a-to-sg-a.flowKgPerS`])
    const alerts = card.items.filter(isAlert)
    expect(alerts).toHaveLength(CARD_ALERTS)
    // SG A's own low-low alarm leads the alerts, ahead of the unit's first-outs.
    expect(alerts[0]!.reading).toMatch(/Steam generator A low-low level/)
    expect(card.adjusted).toContainEqual({ kind: 'layout', text: expect.stringMatching(/^\d+ of \d+ alerts not on the card$/) })
    const [count, total] = card.adjusted.find(entry => entry.text.endsWith('alerts not on the card'))!.text.match(/\d+/g)!.map(Number)
    expect(count).toBe(total! - CARD_ALERTS)
    expect(card.more).toBeGreaterThanOrEqual(count!)
    expect(card.items.every(item => item.object === 'Halden Unit 1')).toBe(true)
  }, 120_000)

  test('an alerts-only card lists what its list shows: its alerts are what the answer is about', async () => {
    const { card } = await compose({ title: 'Anything to worry about?', question: 'Anything to worry about?', subjects: [], views: [{ kind: 'alerts', scope: 'run' }] })
    expect(card.items.length).toBeGreaterThan(CARD_ALERTS)
    expect(card.items.every(isAlert)).toBe(true)
  }, 120_000)

  test('an element\'s drawn readings come before alerts; the drawing\'s other readings after them', async () => {
    const { card } = await compose({ title: 'Unit 1 · SG A', question: 'Does SG A have a heat sink?', subjects: [`${plantId}#sgA`], views: [] })
    const first = card.items.findIndex(isAlert)
    expect(first).toBeGreaterThan(0)
    const after = card.items.slice(first).filter(item => !isAlert(item))
    expect(after.length).toBeGreaterThan(0)
    // None of the readings after the alerts is on SG A or a device it bundles: the drawing's readings of other equipment.
    expect(after.filter(item => /· SG A( |$)/.test(item.label))).toEqual([])
    expect(card.items.filter(isAlert).length).toBeLessThanOrEqual(CARD_ALERTS)
  }, 120_000)

  test('a demand reads as the command it is, as a values view writes it', async () => {
    const { card } = await compose({ title: 'Unit 1 · RCPs', question: 'Are the RCPs asked to run?', subjects: [`${plantId}#RCP-A-RUNNING`], views: [{ kind: 'values', signals: [`${plantId}#RCP-A-RUNNING`] }] })
    expect(card.items[0]).toMatchObject({ label: expect.stringContaining('Run command'), reading: expect.stringMatching(/^CMD (yes|no)/) })
  }, 120_000)
})

const e0 = {
  title: 'Unit 1 · E-0 checks', question: 'Verify the E-0 checks: reactor trip, heat sink with AFW flow to each SG, and RCP status.', need: 'The trip breakers, the AFW flow into each SG and the RCPs',
  subjects: [plantId], views: [{ kind: 'values', signals: ['RTB-A', 'RTB-B', 'AFW-A-FLOW', 'AFW-B-FLOW', 'AFW-C-FLOW', 'AFW-D-FLOW', 'RCP-A-RUNNING', 'RCP-B-RUNNING', 'RCP-C-RUNNING', 'RCP-D-RUNNING'].map(tag => `${plantId}#${tag}`) }],
}

describe('an answer\'s view (W7.3, W7.4, W8.2)', () => {
  test('its values grouped by element: several on one under its name, parallel ones as one table named as they read, in the rows composed', async () => {
    const { state } = await compose(e0)
    const view = await compileVignette(await runNow(), state)
    const values = view.sections[0] as Extract<VignetteSection, { kind: 'values' }>
    const blocks = values.blocks!
    expect(blocks.map(block => block.kind === 'table' ? `table ${block.table.quantities.map(quantity => quantity.label).join('|')} × ${block.table.lines.map(line => line.element.shortLabel).join(',')}` : `${block.element?.shortLabel ?? 'rows'}: ${block.values.length}`))
      .toEqual(['RTB A: 2', 'RTB B: 2', 'table flow × AFW valve A → SG A,AFW valve B → SG B,AFW valve C → SG C,AFW valve D → SG D', 'table Run command × RCP A,RCP B,RCP C,RCP D'])
    expect(values.rows).toBe(blockRows(blocks))
    expect(state.views[0]!.rows).toBe(blockRows(blocks))
    // Every part is on Halden Unit 1: a label drops it, as under a title that names it (W7.3).
    expect(view.subject).toEqual({ object: 'Halden Unit 1' })
    expect(underTitle(values.values[0]!.label, view.title, view.subject)).toBe('Breaker closed · RTB A')
    // An answer about one element: its values drop the element too.
    const valve = await compose({ title: 'Unit 1 · AFW valve A', question: 'How is AFW valve A?', subjects: [`${plantId}#auxFeedwaterValveA`], views: [{ kind: 'values', signals: [`${plantId}#AFW-A-CV-POS`] }] })
    const one = await compileVignette(await runNow(), valve.state)
    expect(one.subject).toEqual({ object: 'Halden Unit 1', element: 'AFW valve A' })
    const row = (one.sections[0] as Extract<VignetteSection, { kind: 'values' }>).values[0]!
    expect(underTitle(row.label, one.title, one.subject)).not.toContain('AFW valve A')
  }, 120_000)

  test('only parallel trains make a table: an SG\'s feed and its steam, both of train A, read as rows', () => {
    const flow = (ref: string, element: VignetteElement): VignetteValue => ({ ref, label: `Unit · ${ref}`, quantity: 'flow', unit: 'kg/s', valueType: 'number', thresholds: [], series: null, element })
    const feed = { id: 'feed-a', class: 'fluidFlow', label: 'AFW to SG A', group: 'A' }
    const steam = { id: 'steam-a', class: 'fluidFlow', label: 'SG A to MSIV A', group: 'A' }
    expect(elementBlocks([flow('u#feed-a', feed), flow('u#steam-a', steam)])).toBeNull()
    const blocks = elementBlocks([flow('u#feed-a', feed), flow('u#feed-b', { ...feed, id: 'feed-b', label: 'AFW to SG B', group: 'B' })])!
    expect(blocks.map(block => block.kind)).toEqual(['table'])
    expect(blockRows(blocks)).toBe(3)
  })

  test('it says why and when it was composed, in a row of its own; the model it read stays the model', async () => {
    const outcome = await compose(e0)
    expect(outcome.state.why).toBe(`${e0.question} — ${e0.need}`)
    expect(Object.keys(outcome.state.models ?? {})).toEqual([plantId])
    // The frame keeps a row for the notice: title, notice, footer and the views.
    expect(outcome.rows).toBe(FRAME_ROWS + 1 + outcome.state.views.reduce((sum, view) => sum + view.rows, 0))
    const view = await compileVignette(await runNow(), outcome.state)
    expect(view.answer).toEqual({ why: outcome.state.why!, at: outcome.state.at })
  }, 120_000)

  test('revision: a model that changed after the answer is said; World defaults say nothing of an answer', async () => {
    const { state } = await compose(e0)
    const changed = await compileVignette(await runNow(), { ...state, models: { [plantId]: 'an-earlier-model' } } as typeof state)
    expect(changed.answer).toMatchObject({ modelChanged: true })
    expect(answerNotices({ reset: false, modelChanged: changed.answer!.modelChanged === true })).toEqual(['Model changed after this answer'])
    const { by: _by, why: _why, models: _models, ...asDefault } = state
    expect((await compileVignette(await runNow(), asDefault as typeof state)).answer).toBeUndefined()
  }, 120_000)

  test('reset: a sample behind the answer\'s time, or behind the one before it, says the Run was reset after the answer', async () => {
    const at = (clock: string) => ({ at: `2026-07-12T${clock}.000Z`, clock: 'simulation' as const })
    expect(resetSeen(at('04:05:00'), undefined, at('04:05:00'))).toBe(false)
    expect(resetSeen(at('04:05:00'), at('04:05:00'), at('04:06:00'))).toBe(false)
    expect(resetSeen(at('04:05:00'), undefined, at('04:00:30'))).toBe(true)
    expect(resetSeen(at('04:05:00'), at('04:09:00'), at('04:06:00'))).toBe(true)
    expect(resetSeen(at('04:05:00'), undefined, { at: '2026-07-12T04:00:00.000Z', clock: 'wall' })).toBe(false)
    // The Run reset: its first sample stands at the scenario's start, behind the answer composed five minutes in.
    const { state } = await compose(e0)
    runtime = await registry.reset(runtime.id)
    const sample = await sampleVignette(await runNow(), state)
    expect(resetSeen(state.at, undefined, sample.at)).toBe(true)
    expect(answerNotices({ reset: true, modelChanged: false })).toEqual(['Run reset after this answer'])
  }, 120_000)
})
