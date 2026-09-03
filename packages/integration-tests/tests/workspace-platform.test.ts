import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceIdSchema, workspaceDefinitionCatalogSchema, workspaceResourceCatalogSchema } from '@leitbild/contracts'
import { openCompanion } from '../../../apps/leitbild/src/ui/companion.ts'
import { request as hostRequest } from '../../../apps/leitbild/src/ui/api.ts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../../../apps/world/tests/helpers.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { asAIAgent } from '../../../apps/agents/src/agents/shared.ts'
import { BUNDLED_ROOM_DEFINITIONS } from '../../../apps/agents/src/core/definitions/room-definition-catalog.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import {
  createWorkspaceRuntimeRegistry as createAgentsWorkspaceRuntimeRegistry,
  type WorkspaceRuntimeRegistry as AgentsWorkspaceRuntimeRegistry,
} from '../../../apps/agents/src/core/workspaces/runtime-registry.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
})

describe('Workspace Host with real Modules', () => {
  test('provisions real World and Agents Modules without stored Resource bindings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-combined-world-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'workspace-combined-ui-'))
    const leitbildHome = await mkdtemp(join(tmpdir(), 'workspace-combined-leitbild-'))
    const originalLeitbildHome = process.env.LEITBILD_HOME
    const originalProvider = process.env.PROVIDER
    const originalSeed = process.env.LEITBILD_SEED_WORKSPACE
    process.env.LEITBILD_HOME = leitbildHome
    process.env.PROVIDER = 'ollama'
    delete process.env.LEITBILD_SEED_WORKSPACE

    let leitbildRegistry: AgentsWorkspaceRuntimeRegistry | undefined
    cleanup.push(async () => {
      await leitbildRegistry?.shutdown()
      if (originalLeitbildHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = originalLeitbildHome
      if (originalProvider === undefined) delete process.env.PROVIDER
      else process.env.PROVIDER = originalProvider
      if (originalSeed === undefined) delete process.env.LEITBILD_SEED_WORKSPACE
      else process.env.LEITBILD_SEED_WORKSPACE = originalSeed
      await rm(leitbildHome, { recursive: true, force: true })
    })
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    cleanup.push(() => rm(uiDir, { recursive: true, force: true }))

    const worldRegistry = createWorldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const worldServer = createWorldServer({
      workspaces: worldRegistry,
      bindHost: '127.0.0.1',
      port: 0,
      uiDistPath: uiDir,
      mapArtifacts: { rootDir: join(dataDir, 'maps') },
    })
    cleanup.push(() => worldServer.stop())

    const leitbildState = createAgentsModuleState()
    const leitbildServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!leitbildRegistry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
        const url = new URL(request.url)
        return await handleAgentsModuleApi(request, url, { state: leitbildState, registry: leitbildRegistry })
          ?? new Response('Not found', { status: 404 })
      },
    })
    cleanup.push(() => leitbildServer.stop(true))

    const store = createWorkspaceStore(':memory:')
    cleanup.push(() => store.close())
    const host = createWorkspaceHost({
      store,
      modules: createModuleGateway({
        registrations: [
          moduleRegistrationSchema.parse({
            moduleId: 'world',
            internalBaseUrl: `http://127.0.0.1:${worldServer.port}`,
            manifestPath: '/.well-known/workspace-module',
          }),
          moduleRegistrationSchema.parse({
            moduleId: 'agents',
            internalBaseUrl: `http://127.0.0.1:${leitbildServer.port}`,
            manifestPath: '/.well-known/workspace-module',
          }),
        ],
      }),
    })
    const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
    cleanup.push(() => hostServer.stop(true))
    const baseUrl = `http://127.0.0.1:${hostServer.port}`

    leitbildRegistry = createAgentsWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState: leitbildState,
      workspaceHostUrl: baseUrl,
      idleMs: 1_000_000,
    })

    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Combined Lab' }),
    })
    expect(createdResponse.status).toBe(201)
    const workspace = (await createdResponse.json() as {
      workspace: { id: string; modules: Array<{ moduleId: string; status: string }> }
    }).workspace
    expect(workspace.modules.map(module => [module.moduleId, module.status])).toEqual([
      ['agents', 'ready'],
      ['world', 'ready'],
    ])

    const capabilityCatalogResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities`)
    expect(capabilityCatalogResponse.status).toBe(200)
    const capabilityIds = new Set((await capabilityCatalogResponse.json() as {
      capabilities: Array<{ id: string }>
    }).capabilities.map(capability => capability.id))
    const integratedRoom = BUNDLED_ROOM_DEFINITIONS
      .find(definition => definition.id === 'halden-integrated-control-room')
    if (!integratedRoom) throw new Error('Missing integrated Room Definition')
    const worldGrants = integratedRoom.room.agents
      .flatMap(agent => agent.toolGrants ?? [])
      .map(grant => String(grant.capabilityId))
      .filter(capabilityId => capabilityId.startsWith('world.'))
    expect(worldGrants.length).toBeGreaterThan(0)
    expect(worldGrants.filter(capabilityId => !capabilityIds.has(capabilityId))).toEqual([])
    const dispatchDefinition = BUNDLED_ROOM_DEFINITIONS.find(definition => definition.id === 'ambulance-dispatcher')!
    expect(dispatchDefinition).toBeDefined()
    const dispatchGrants = dispatchDefinition.room.agents.flatMap(agent => agent.toolGrants ?? [])
    expect(dispatchGrants.filter(grant => !capabilityIds.has(String(grant.capabilityId)))).toEqual([])

    const definitionCatalog = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/definitions`)
    expect(definitionCatalog.status).toBe(200)
    const scenario = (await definitionCatalog.json() as {
      definitions: Array<{ ref: Record<string, string>; currentRevisionId: string }>
    }).definitions.find(
      (definition) => definition.ref.type === 'world.scenario' && definition.ref.id === 'halden-weather-response',
    )!
    const createRunResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.scenario.start/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
          input: {},
        }),
      },
    )
    expect(createRunResponse.status).toBe(200)
    const runId = (await createRunResponse.json() as { result: { id: string } }).result.id

    // Exercise the same discovery → Host broker → Agents Definition → Room
    // path as opening a World run in the browser, with both real Modules.
    const definitions = workspaceDefinitionCatalogSchema.parse(await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/definitions`)).json()).definitions
    const resources = workspaceResourceCatalogSchema.parse(await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)).json()).resources
    const worldRun = resources.find(resource => resource.ref.id === runId)!
    const companionRef = await openCompanion(worldRun, definitions, resources, (path, init) => hostRequest(`${baseUrl}${path}`, init))
    const companionRuntime = await leitbildRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    const companionRoom = companionRuntime.rooms.getRoom(companionRef.id)!
    const assistant = companionRoom.getParticipantIds().map(id => companionRuntime.team.getAgent(id)).find(agent => agent?.kind === 'ai')!
    expect(companionRoom.getParticipantIds()).toHaveLength(2)
    expect(JSON.stringify(asAIAgent(assistant)!.getConfig())).not.toContain(runId)
    const companionContext = { callerId: assistant.id, callerName: assistant.name, roomId: companionRef.id }
    const companionDiscovery = await companionRuntime.toolRegistry.get('workspace_catalog')!.execute({ moduleId: 'world' }, companionContext)
    expect(companionDiscovery).toMatchObject({ success: true, data: { currentRoom: { links: expect.arrayContaining([{ rel: 'companion-of', ref: worldRun.ref }]) } } })
    expect(await companionRuntime.toolRegistry.get('workspace_invoke')!.execute({ capabilityId: 'world.simulation-run.context', resource: worldRun.ref, input: {} }, companionContext)).toMatchObject({ success: true })
    expect(await companionRuntime.toolRegistry.get('workspace_invoke')!.execute({ capabilityId: 'world.ambulance.dispatch-state', resource: worldRun.ref, input: {} }, companionContext)).toMatchObject({ success: true })
    expect(await companionRuntime.toolRegistry.get('workspace_invoke')!.execute({ capabilityId: 'world.ambulance.cancel', resource: worldRun.ref, input: { ambulanceId: 'amb:weather-response' } }, companionContext)).toMatchObject({ success: false, error: expect.stringContaining('capability_not_granted') })
    expect(await companionRuntime.toolRegistry.get('workspace_invoke')!.execute({ capabilityId: 'world.simulation-run.delete', resource: worldRun.ref, input: {} }, companionContext)).toMatchObject({ success: false, error: expect.stringContaining('capability_not_granted') })

    const createAgentResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/agents.agent.create/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: {
            name: 'World Observer',
            model: 'test-model',
            persona: 'Inspect available Workspace Resources when asked.',
            toolGrants: [
              ...dispatchGrants,
              { capabilityId: 'world.simulation-run.read' },
              { capabilityId: 'world.weather.sample-at-point' },
              { capabilityId: 'world.weather.intervene-ground' },
            ],
          },
          actor: { kind: 'human', id: 'operator', displayName: 'Operator' },
        }),
      },
    )
    expect(createAgentResponse.status).toBe(200)
    const agentId = (await createAgentResponse.json() as { result: { id: string } }).result.id
    const runtime = await leitbildRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    const agent = runtime.team.getAgent(agentId)
    const aiAgent = agent ? asAIAgent(agent) : undefined
    expect(aiAgent).toBeDefined()
    expect(JSON.stringify(aiAgent?.getConfig() ?? {})).not.toContain(runId)

    const context = { callerId: agentId, callerName: 'World Observer' }
    const discover = runtime.toolRegistry.get('workspace_catalog')
    const invoke = runtime.toolRegistry.get('workspace_invoke')
    expect(discover).toBeDefined()
    expect(invoke).toBeDefined()
    const discovered = await discover!.execute(
      {},
      context,
    )
    expect(discovered.success).toBe(true)
    const currentRun = (discovered.data as {
      resources: Array<{
        ref: { moduleId: string; type: string; id: string }
        summary: Array<{ key: string; kind: string; value: unknown }>
      }>
    }).resources.find(resource => resource.ref.type === 'world.simulation-run')!
    expect(currentRun.ref.id).toBe(runId)
    expect(currentRun.summary.find(item => item.key === 'viewer-count')).toMatchObject({ kind: 'count', value: 0 })

    const read = await invoke!.execute({
      capabilityId: 'world.simulation-run.read',
      resource: currentRun.ref,
      input: {},
    }, context)
    expect(read.success).toBe(true)
    expect((read.data as { id: string }).id).toBe(runId)

    // Real Agent tool → Host broker → World command, without any model call or
    // stored Run ID in the profile. Discover IDs, check eligibility, act, verify.
    const initialDispatch = await invoke!.execute({ capabilityId: 'world.ambulance.dispatch-state', resource: currentRun.ref, input: {} }, context)
    expect(initialDispatch.success).toBe(true)
    const dispatchState = initialDispatch.data as { units: Array<{ id: string }>; incidents: Array<{ id: string }>; patients: Array<{ id: string; incidentId: string }>; careSites: Array<{ id: string }> }
    const unitId = dispatchState.units[0]!.id
    const incidentId = dispatchState.incidents[0]!.id
    const patientIds = dispatchState.patients.filter(patient => patient.incidentId === incidentId).map(patient => patient.id)
    const cancel = await invoke!.execute({ capabilityId: 'world.ambulance.cancel', resource: currentRun.ref, input: { ambulanceId: unitId } }, context)
    expect(cancel).toMatchObject({ success: true, data: { ok: true } })
    const options = await invoke!.execute({ capabilityId: 'world.ambulance.dispatch-options', resource: currentRun.ref, input: { action: 'assign', incidentId, patientIds } }, context)
    expect(options).toMatchObject({ success: true, data: { candidates: expect.arrayContaining([expect.objectContaining({ id: unitId, eligible: true })]) } })
    const dispatched = await invoke!.execute({ capabilityId: 'world.ambulance.assign', resource: currentRun.ref, input: { ambulanceId: unitId, incidentId, patientIds } }, context)
    expect(dispatched).toMatchObject({ success: true, data: { ok: true } })
    const planned = await invoke!.execute({ capabilityId: 'world.ambulance.append-stop', resource: currentRun.ref, input: { kind: 'handover', ambulanceId: unitId, careSiteId: dispatchState.careSites[0]!.id, patientIds } }, context)
    expect(planned).toMatchObject({ success: true, data: { ok: true } })
    const afterDispatch = await invoke!.execute({ capabilityId: 'world.ambulance.dispatch-state', resource: currentRun.ref, input: {} }, context)
    expect(afterDispatch).toMatchObject({ success: true, data: { units: expect.arrayContaining([expect.objectContaining({ id: unitId, patientIds, phase: 'mobilizing', stops: expect.arrayContaining([expect.objectContaining({ kind: 'pickup', targetId: incidentId })]) })]) } })

    const weatherPoint = { type: 'Point', coordinates: [11.41, 59.13] }
    const weatherRead = await invoke!.execute(
      { capabilityId: 'world.weather.sample-at-point', resource: currentRun.ref, input: { point: weatherPoint } },
      context,
    )
    expect(weatherRead.success).toBe(true)
    expect((weatherRead.data as { quality: { model: string } }).quality.model).toBe(
      'prescribed-atmosphere/heuristic-ground',
    )
    const intervention = await invoke!.execute(
      {
        capabilityId: 'world.weather.intervene-ground',
        resource: currentRun.ref,
        input: {
          area: {
            type: 'Polygon',
            coordinates: [
              [
                [11.4, 59.12],
                [11.42, 59.12],
                [11.42, 59.14],
                [11.4, 59.14],
                [11.4, 59.12],
              ],
            ],
          },
          surface: { ice: 0.8 },
        },
      },
      context,
    )
    expect(intervention).toMatchObject({ success: true })
    const afterWeather = await invoke!.execute(
      { capabilityId: 'world.weather.sample-at-point', resource: currentRun.ref, input: { point: weatherPoint } },
      context,
    )
    expect(afterWeather.success).toBe(true)
    expect((afterWeather.data as { state: { surface: { ice: number } } }).state.surface.ice).toBeCloseTo(0.8, 1)

    const deleteRun = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.simulation-run.delete/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: currentRun.ref, input: {} }),
      },
    )
    expect(deleteRun.status).toBe(200)
    expect(companionRuntime.rooms.getRoom(companionRef.id)).toBeDefined()
    const resourcesAfterDelete = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)
    expect(resourcesAfterDelete.status).toBe(200)
    expect((await resourcesAfterDelete.json() as {
      resources: Array<{ ref: { id: string } }>
    }).resources.some(resource => resource.ref.id === runId)).toBe(false)

    expect((await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await worldRegistry.list()).toEqual([])
    expect(await leitbildState.has(workspaceIdSchema.parse(workspace.id))).toBe(false)
  })
})
