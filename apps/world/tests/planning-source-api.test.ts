import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, newRequestId, newWorkspaceId, planningSourceBasisSchema } from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test('public planning capture/qualification uses the exact Run and enforces shared audience even for a human', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'planning-source-api-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const workspaces = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
  })
  cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const workspaceId = newWorkspaceId()
  await workspaces.provision(workspaceId)
  const registry = workspaces.getLoaded(workspaceId)!.simulationRuns
  const run = await registry.create({ scenarioId: 'planning-response' })
  const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }
  const invoke = async (capabilityId: string, input: unknown, kind: 'human' | 'ai' = 'human') => {
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, resource, input, access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind, id: 'planning-api' } }) }),
    })
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw new Error('World did not answer its planning operation')
    return { status: response.status, body: await response.json() as { result?: unknown; error?: { code: string } } }
  }
  const first = await invoke('world.einsatz.planning-basis', {})
  expect(first.status).toBe(200)
  const basis = planningSourceBasisSchema.parse(first.body.result)
  expect(String(basis.source.id)).toBe(String(run.id))
  expect((await invoke('world.planning-source.qualify', { profile: basis.profile, qualification: basis.qualification })).body.result).toEqual({ allowed: true })
  expect((await invoke('world.einsatz.planning-basis', {}, 'ai')).status).toBe(200)
  await run.setAgentRestrictions({ id: actorIdSchema.parse('actor:controller'), label: 'Controller', role: 'controller' }, {
    operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:planning-a'), deny: ['inspect'] }],
  }, 0)
  expect((await invoke('world.einsatz.planning-basis', {})).status).toBe(403)
  expect((await invoke('world.planning-source.qualify', { profile: basis.profile, qualification: basis.qualification })).body.result).toMatchObject({ allowed: false })
  await registry.close(run.id)
  expect(registry.get(run.id)).toBeUndefined()
  expect((await invoke('world.planning-source.qualify', { profile: basis.profile, qualification: basis.qualification })).body.result).toMatchObject({ allowed: false, code: 'source_unloaded' })
  expect(registry.get(run.id)).toBeUndefined()
})
