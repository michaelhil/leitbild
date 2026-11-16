import { accessContextSchema, moduleCapabilityCollectionSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import type { IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import type { RecommendAnswer } from '../src/packs/einsatz/recommendation-schema.ts'
import type { Situation } from '../src/packs/einsatz/situation/schema.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'

/**
 * E.4, unpaid: an AI agent dispatches in the open halden-emergency Run
 * through the World Capability path the Host broker calls (the World module
 * API, actor kind `ai`): situation, recommend, unit.order, undo, and a
 * two-stop delivery, each refusal with its own code. The same agent in the
 * sided halden-border Run is refused by the role gate.
 */

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const definitions = builtinScenarioDefinitions.filter(definition => ['halden-emergency', 'halden-border'].includes((definition as { readonly id: string }).id))
let dataDir = ''
let workspaces: WorldWorkspaceRuntimeRegistry
const workspaceId: WorkspaceId = newWorkspaceId()

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'einsatz-ai-broker-'))
  workspaces = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }), runtimeAdapters: assembly.runtimeAdapters,
    workspaceCapabilities: assembly.packs.flatMap(pack => pack.workspaceCapabilities ?? []),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: definitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
  })
  await workspaces.provision(workspaceId)
})
afterAll(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const route = async (path: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: any }> => {
  const request = new Request(`http://world.test${path}`, init)
  const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
  if (!response) throw new Error(`Module route did not handle ${path}`)
  return { status: response.status, body: await response.json() }
}
const ai = async (capabilityId: string, run: SimulationRunId, input: unknown = {}) => await route(`/internal/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId, capabilityId, input, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run }, access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'einsatz-test-agent' } }) }),
})
const startRun = async (scenarioId: string): Promise<SimulationRunId> => await workspaces.withRuntime(workspaceId, async runtime => {
  const run = await runtime.simulationRuns.create({ scenarioId })
  await run.setClock({ paused: true })
  return run.id
})
const runOf = async (id: SimulationRunId) => await workspaces.withRuntime(workspaceId, async runtime => runtime.simulationRuns.get(id)!)
const forward = async (id: SimulationRunId, seconds: number): Promise<void> => {
  const run = await runOf(id)
  const at = Date.parse(run.snapshot().clock!.currentTime)
  await run.runMaximumPace(new Date(at + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
}

const unitRow = (situation: Situation, unitId: string) => situation.units.find(unit => unit.id === unitId)!

describe('an AI agent dispatches in the open halden-emergency Run', () => {
  test('the dispatch surface is found by its words: situation says start here and carries the search terms', async () => {
    const listed = moduleCapabilityCollectionSchema.parse((await route(`/internal/workspaces/${workspaceId}/capabilities`)).body)
    const situation = listed.capabilities.find(capability => capability.id === 'world.einsatz.situation')!
    expect(situation.searchTerms).toEqual(expect.arrayContaining(['dispatch', 'what is running']))
    expect(situation.description).toContain('Start here')
    expect(listed.capabilities.filter(capability => capability.id.startsWith('world.einsatz.')).map(capability => String(capability.id)).sort()).toEqual([
      'world.einsatz.configuration', 'world.einsatz.recommend', 'world.einsatz.site.set', 'world.einsatz.situation', 'world.einsatz.task.close', 'world.einsatz.task.create',
      'world.einsatz.unit.adjust', 'world.einsatz.unit.create', 'world.einsatz.unit.engage', 'world.einsatz.unit.options', 'world.einsatz.unit.order',
      'world.einsatz.unit.plan.reorder', 'world.einsatz.unit.plan.routes', 'world.einsatz.unit.recall', 'world.einsatz.unit.set-roe',
      'world.einsatz.unit.stop.remove', 'world.einsatz.unit.undo',
    ])
  })

  test('situation, recommend, unit.order: three calls dispatch the waiting call, attributed to the agent', async () => {
    const run = await startRun('halden-emergency')
    const situation = (await ai('world.einsatz.situation', run)).body.result as Situation
    const waiting = situation.calls[0]!
    expect(waiting).toMatchObject({ id: 'task:tistedal-fall', priority: { code: 'P2' } })
    const recommendation = (await ai('world.einsatz.recommend', run, { taskId: waiting.id })).body.result as RecommendAnswer
    const suggested = recommendation.proposal!.units[0]!.unitId
    expect(recommendation.proposal?.order).toEqual({ units: [suggested], stops: [{ taskId: waiting.id }] })
    const ordered = await ai('world.einsatz.unit.order', run, recommendation.proposal!.order)
    expect(ordered).toMatchObject({ status: 200, body: { result: { ok: true, commandId: expect.stringMatching(/^command:/) } } })
    const after = (await ai('world.einsatz.situation', run)).body.result as Situation
    expect(unitRow(after, suggested)).toMatchObject({ phase: 'mobilizing', lastOrder: { by: { label: 'AI agent' }, commandId: ordered.body.result.commandId } })
    expect(after.calls[0]!.assigned).toMatchObject([{ unitId: suggested, by: { label: 'AI agent' } }])
  })

  test('a busy unit without when, and now with the wrong drops, are refused each with its own code', async () => {
    const run = await startRun('halden-emergency')
    await ai('world.einsatz.unit.order', run, { units: ['unit:amb-4'], stops: [{ taskId: 'task:tistedal-fall' }] })
    await forward(run, 45)
    const situation = (await ai('world.einsatz.situation', run)).body.result as Situation
    const crash = situation.calls.find(call => call.label.startsWith('C-2'))!
    expect(await ai('world.einsatz.unit.order', run, { units: ['unit:amb-4'], stops: [{ taskId: crash.id }] })).toMatchObject({ status: 409, body: { error: { code: 'when_required' } } })
    expect(await ai('world.einsatz.unit.order', run, { units: ['unit:amb-4'], stops: [{ taskId: crash.id }], when: 'now', drops: crash.id })).toMatchObject({ status: 409, body: { error: { code: 'drops_mismatch' } } })
  })

  test('undo is bound to its order: a stale command id is refused newer_order_exists, the latest is accepted', async () => {
    const run = await startRun('halden-emergency')
    const first = await ai('world.einsatz.unit.order', run, { units: ['unit:amb-1'], stops: [{ point: { type: 'Point', coordinates: [11.39, 59.13] } }] })
    const second = await ai('world.einsatz.unit.order', run, { units: ['unit:amb-1'], stops: [{ taskId: 'task:tistedal-fall' }] })
    expect(await ai('world.einsatz.unit.undo', run, { unitId: 'unit:amb-1', commandId: first.body.result.commandId })).toMatchObject({ status: 409, body: { error: { code: 'newer_order_exists' } } })
    expect(await ai('world.einsatz.unit.undo', run, { unitId: 'unit:amb-1', commandId: second.body.result.commandId })).toMatchObject({ status: 200, body: { result: { ok: true } } })
  })

  test('two recommendations with an order between never propose the same unit', async () => {
    const run = await startRun('halden-emergency')
    const first = (await ai('world.einsatz.recommend', run, { taskId: 'task:tistedal-fall' })).body.result as RecommendAnswer
    await ai('world.einsatz.unit.order', run, first.proposal!.order)
    const again = (await ai('world.einsatz.recommend', run, { taskId: 'task:tistedal-fall' })).body.result as RecommendAnswer
    for (const unitId of first.proposal!.order.units) expect(again.proposal?.order.units ?? []).not.toContain(unitId)
  })

  test('pick up at C-2 and deliver to the triage post: one order, delivered there', async () => {
    const run = await startRun('halden-emergency')
    await forward(run, 45)
    const crash = ((await ai('world.einsatz.situation', run)).body.result as Situation).calls.find(call => call.label.startsWith('C-2'))!
    const ordered = await ai('world.einsatz.unit.order', run, { units: ['unit:amb-2'], stops: [{ taskId: crash.id }, { siteId: 'site:remmen-triage' }] })
    expect(ordered.status).toBe(200)
    expect(unitRow((await ai('world.einsatz.situation', run)).body.result, 'unit:amb-2').plan.map((stop: { verb: string }) => stop.verb)).toEqual(['pick-up', 'deliver'])
    await forward(run, 20 * 60)
    const triage = ((await ai('world.einsatz.situation', run)).body.result as Situation).sites.find(site => site.id === 'site:remmen-triage')
    expect(triage).toBeDefined()
    const received = (await runOf(run)).snapshot().objects.find(object => object.id === 'site:remmen-triage')!.packData as { readonly received?: Readonly<Record<string, number>> }
    expect(received.received).toEqual({ urgent: 1 })
  }, 120_000)
})

describe('the same agent in a sided Run', () => {
  test('is refused by the role gate', async () => {
    const run = await startRun('halden-border')
    expect(await ai('world.einsatz.situation', run)).toMatchObject({ status: 403, body: { error: { code: 'ai_role_run_unsupported' } } })
    expect(await ai('world.einsatz.unit.order', run, { units: ['unit:x'], stops: [{ taskId: 'task:y' }] })).toMatchObject({ status: 403, body: { error: { code: 'ai_role_run_unsupported' } } })
  })
})
