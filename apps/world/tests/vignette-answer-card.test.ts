import { newWorkspaceId } from '@leitbild/contracts'
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
import type { ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// An answer's vignette on four-loop Halden five minutes into a loss of offsite power (plan v5 W7, W8.2): its card
// lists the subjects' readings before alerts, the subjects' own alerts first and, past readings, the worst three
// with a count of the rest; it writes a demand as the command it is; each line names its object once.

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
const isAlert = (item: { readonly subject?: object }): boolean => item.subject !== undefined && 'alertId' in item.subject
const refOf = (item: { readonly subject?: object }): string | undefined => item.subject !== undefined && 'ref' in item.subject ? String(item.subject.ref) : undefined

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
