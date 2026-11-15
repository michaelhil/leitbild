import { accessContextSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import type { RecommendAnswer } from '../src/packs/einsatz/recommendation-schema.ts'
import type { Situation } from '../src/packs/einsatz/situation/schema.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

/**
 * E.4, unpaid: an AI agent authors a new asset type with configuration only.
 * It reads the authoring description, creates a Scenario whose Einsatz
 * configuration declares a rescue boat, a person-in-water template and a
 * call, starts it, and dispatches the boat through situation, recommend and
 * unit.order. No code knows the boat.
 */

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
let dataDir = ''
let workspaces: WorldWorkspaceRuntimeRegistry
const workspaceId: WorkspaceId = newWorkspaceId()

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'einsatz-ai-authoring-'))
  workspaces = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }), runtimeAdapters: assembly.runtimeAdapters,
    workspaceCapabilities: assembly.packs.flatMap(pack => pack.workspaceCapabilities ?? []),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: [],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
  })
  await workspaces.provision(workspaceId)
})
afterAll(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const ai = async (capabilityId: string, input: unknown, target: Record<string, unknown> = {}): Promise<{ readonly status: number; readonly body: any }> => {
  const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, capabilityId, input, ...target, access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'einsatz-author-agent' } }) }),
  })
  const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
  if (!response) throw new Error(`Module route did not handle ${capabilityId}`)
  return { status: response.status, body: await response.json() }
}

/** What an agent writes from the authoring description: one new type, one new template, one call. */
const harbourRescue = {
  id: 'harbour-rescue',
  title: 'Harbour rescue',
  world: { startsAt: '2026-09-03T12:00:00.000Z', environment: {} },
  view: { map: { center: [11.38, 59.12], zoom: 13 } },
  packs: [{
    id: 'einsatz',
    config: {
      priorities: [{ id: 'urgent', label: 'Urgent', code: 'U1', responseTargetS: 600 }, { id: 'routine', label: 'Routine', code: 'U2' }],
      loadClasses: [{ id: 'swimmer', label: 'Swimmer', code: 'S', noun: { one: 'swimmer', other: 'swimmers' } }],
      unitTypes: [
        { id: 'rescue-boat', label: 'Rescue boat', icon: 'life-buoy',
          components: { mobility: { mode: 'direct', speedMps: 12, mobilizeS: 30 }, service: { provides: ['water-rescue'], onSceneS: 120 }, carry: { capacity: 2, classes: ['swimmer'] } },
          standingOrders: { deliver: 'nearest-accepting', return: { afterIdleS: 60 } } },
        { id: 'quay', label: 'Quay', icon: 'anchor', public: true, components: { receiving: { accepts: ['swimmer'], slots: 1, handoverS: 60, accepting: true } } },
      ],
      taskTemplates: [{ id: 'person-in-water', label: 'Person in water', icon: 'waves', priority: 'urgent', requires: [{ provides: 'water-rescue', count: 1, label: { one: 'boat', other: 'boats' } }] }],
    },
    items: [
      { type: 'unit', id: 'unit:boat-1', label: 'Boat 1', unitType: 'rescue-boat', position: [11.37, 59.115] },
      { type: 'unit', id: 'site:quay', label: 'Guest quay', unitType: 'quay', position: [11.385, 59.12] },
      { type: 'task', id: 'task:piw-1', label: 'W-1 Person in water', template: 'person-in-water', position: [11.38, 59.11], loads: { swimmer: 1 } },
    ],
  }],
}

describe('an AI agent adds an asset type by configuration and dispatches it', () => {
  test('describe, create, start, then situation, recommend and unit.order', async () => {
    const described = await ai('world.scenario-authoring.describe', { detail: 'authoring', packIds: ['einsatz'] })
    expect(described.status).toBe(200)
    expect(JSON.stringify(described.body.result.packs[0])).toContain('priorities')
    const created = await ai('world.scenario.create', { source: harbourRescue })
    expect(created.status).toBe(201)
    const started = await ai('world.scenario.start', {}, { definition: created.body.result.definition })
    expect(started.status).toBe(201)
    const resource = { resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: started.body.result.id } }
    const situation = (await ai('world.einsatz.situation', {}, resource)).body.result as Situation
    expect(situation.units.map(unit => [unit.label, unit.typeLabel])).toEqual([['Boat 1', 'Rescue boat']])
    expect(situation.calls.map(call => [call.label, call.priority.code])).toEqual([['W-1 Person in water', 'U1']])
    expect(situation.sites.map(site => site.label)).toEqual(['Guest quay'])
    const recommendation = (await ai('world.einsatz.recommend', { taskId: 'task:piw-1' }, resource)).body.result as RecommendAnswer
    expect(recommendation.proposal?.order).toEqual({ units: ['unit:boat-1'], stops: [{ taskId: 'task:piw-1' }] })
    expect(recommendation.deliverTo).toMatchObject([{ unitId: 'unit:boat-1', sites: [{ siteId: 'site:quay' }] }])
    const ordered = await ai('world.einsatz.unit.order', recommendation.proposal!.order, resource)
    expect(ordered).toMatchObject({ status: 200, body: { result: { ok: true } } })
    const after = (await ai('world.einsatz.situation', {}, resource)).body.result as Situation
    expect(after.units[0]).toMatchObject({ plan: [{ verb: 'pick-up', label: 'W-1 Person in water' }], predictedDelivery: { siteId: 'site:quay' } })
  }, 60_000)
})
