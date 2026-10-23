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
import { composeDefault, composeVignette } from '../src/features/displays/compose/compose.ts'
import type { VignetteSection, VignetteView } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { valueLook } from '../src/ui/embed/vignette/readout.ts'
import { viewWithLeads } from '../src/ui/embed/vignette/vignette-client.ts'
import faceplates from './fixtures/display-parity/faceplate-rows.json'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// W1.4 on four-loop Halden through a loss of offsite power (E-0 check 10; P7 "shown"): an energy end's detail shows
// the checks its safety functions declare as criterion rows, sampled live, while one of their checks applies (the trip
// verified; natural circulation with no coolant pump running; the heat sink's total feed on a steam generator), and
// the core's loops as one table; an answer about the core cites them as card lines. At power none of the criteria
// applies, so none takes a row; the table is there throughout.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:criteria' as ActorId, label: 'Criteria', role: 'operator' as const }
const plantId = 'plant:halden-1'
const path = (ref: string) => ref.slice(ref.indexOf('#') + 1)

let registry: SimulationRunRegistry
let dataDir: string
let runtime: SimulationRunRuntime
let start: number
const play = (seconds: number) => runtime.runMaximumPace(new Date(start + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
const runNow = (): Promise<ViewRun> => displayRunOf(registry, runtime, person, new Set())
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-criteria-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  runtime = await registry.create({ scenarioId: 'halden-offsite-power-restoration' })
  await runtime.setClock({ paused: true })
  start = Date.parse(runtime.snapshot().clock!.currentTime)
  await play(30)
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

/** An element's detail as the window draws it after a sample: its values section, each row as it reads, and its table. */
const detail = async (subject: string) => {
  const outcome = await composeDefault(await runNow(), subject)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  const view = await compileVignette(await runNow(), outcome.state)
  const sample = await sampleVignette(await runNow(), outcome.state)
  const values = viewWithLeads(view, sample).sections.find(section => section.kind === 'values') as Extract<VignetteSection, { kind: 'values' }>
  const rows = values.values.map(value => ({ ref: path(value.ref), label: value.label.slice(value.label.indexOf(' · ') + 3), look: valueLook(value, sample.observations, value.ref) }))
  return { state: outcome.state, view, values, rows, sample }
}
const criteria = (rows: Awaited<ReturnType<typeof detail>>['rows']) => rows.filter(row => row.look.kind === 'criterion').map(row => `${row.label} ${row.look.text}${row.look.detail === null ? '' : ` · ${row.look.detail}`}`)
const tableOf = (view: VignetteView) => (view.sections.find(section => section.kind === 'values') as Extract<VignetteSection, { kind: 'values' }>).table

describe('criterion rows and the loop table (W1.4)', () => {
  test('at power: no criterion applies, so none takes a row; the core shows its four loops as one table and reserves the rows its criteria may take', async () => {
    const core = await detail(`${plantId}#core`)
    expect(criteria(core.rows)).toEqual([])
    expect(core.state.views[0]).toMatchObject({ kind: 'values', lead: { objectId: plantId, element: 'core' }, table: true, rows: 8 + 2 + 5 })
    const table = tableOf(core.view)!
    expect(table.quantities).toEqual([{ label: 'Thot', unit: 'degC' }, { label: 'Tcold', unit: 'degC' }, { label: 'ΔT', unit: 'degC' }, { label: 'Flow', unit: 'kg/s' }])
    expect(table.lines.map(line => line.element.label)).toEqual(['A', 'B', 'C', 'D'])
    // P7 "shown": the old core faceplate's loop readings, its hot and cold legs and each loop's delta-T, are cells of the table.
    const cells = table.lines.flatMap(line => line.values.flatMap(value => (value === null ? [] : [path(value.ref)])))
    const old = faceplates.ends.find(end => end.end === 'core')!.loops.filter(loop => /^rcs-(hot|cold)-leg-|\.deltaTC$/.test(loop))
    expect(old).toHaveLength(12)
    expect(old.filter(loop => !cells.includes(loop))).toEqual([])
    // Each cell is read in the sample.
    expect(cells.every(cell => core.sample.observations.some(observation => path(observation.ref) === cell && typeof observation.value === 'number'))).toBe(true)
    const sg = await detail(`${plantId}#sgA`)
    expect(criteria(sg.rows)).toEqual([])
  }, 120_000)

  test('after the loss of offsite power (E-0 check 10 in one click): the core leads with the trip verified and natural circulation forming, and a steam generator with the heat sink\'s feed', async () => {
    await play(300)
    const core = await detail(`${plantId}#core`)
    // The criteria first, then what verifies the trip, in the rows reserved at power.
    expect(core.rows.slice(0, 3).map(row => row.ref)).toEqual(['csf.subcriticality.checks', 'csf.core-cooling.checks', 'core.rodsOnBottom'])
    expect(criteria(core.rows)).toEqual(['Reactor trip 4/4', 'Natural circulation 2/5 · not yet met: SG pressures, hot legs, core exit'])
    expect(core.rows.find(row => row.ref === 'csf.subcriticality.checks')!.look.fill).toBe('filled')
    expect(core.rows.find(row => row.ref === 'csf.core-cooling.checks')!.look).toMatchObject({ fill: 'hollow', tone: null })
    expect(core.values.rows).toBe(15)
    expect(tableOf(core.view)!.lines).toHaveLength(4)
    const sg = await detail(`${plantId}#sgA`)
    expect(sg.rows[0]!.ref).toBe('csf.heat-sink.checks')
    expect(criteria(sg.rows)).toEqual([expect.stringMatching(/^Heat sink 1\d\d ≥ 27\.8 kg\/s$/)])
  }, 240_000)

  test('an answer about the core gets the criteria that apply as criterion rows, each a card line its numbers cite', async () => {
    const outcome = await composeVignette(await runNow(), displaySpecSchema.parse({ title: 'Core cooling', question: 'Is natural circulation established?', subjects: [`${plantId}#core`], views: [] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect(outcome.state.views[0]).toMatchObject({ kind: 'values', refs: expect.arrayContaining([`${plantId}#csf.core-cooling.checks`]) })
    const line = outcome.card.items.find(item => item.subject !== undefined && 'ref' in item.subject && item.subject.ref === `${plantId}#csf.core-cooling.checks`)
    expect(line).toMatchObject({ label: 'Halden Unit 1 · Natural circulation', reading: '2/5 · not yet met: SG pressures, hot legs, core exit', numbers: [{ value: 2, decimals: 0 }, { value: 5, decimals: 0 }] })
    const feed = await composeVignette(await runNow(), displaySpecSchema.parse({ title: 'Heat sink', question: 'Is the heat sink fed?', subjects: [`${plantId}#sgA`], views: [] }))
    if (!feed.ok) throw new Error(JSON.stringify(feed.issues))
    const criterion = feed.card.items.find(item => item.subject !== undefined && 'ref' in item.subject && item.subject.ref === `${plantId}#csf.heat-sink.checks`)!
    expect(criterion).toMatchObject({ label: 'Halden Unit 1 · Heat sink', unit: 'kg/s' })
    expect(criterion.numbers[1]).toEqual({ value: 27.8, decimals: 1 })
    expect(criterion.reading).toBe(`${criterion.numbers[0]!.value} ≥ 27.8 kg/s`)
  }, 120_000)
})
