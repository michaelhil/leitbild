import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, engineeringContinuationReceiptSchema, engineeringInputBasisSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
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

test('published World capture and job capabilities validate Run scope, keyed retries, read-only views and changed source policy', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'engineering-api-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters })
  cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const workspaceId = newWorkspaceId(); await workspaces.provision(workspaceId)
  const registry = workspaces.getLoaded(workspaceId)!.simulationRuns, run = await registry.create({ scenarioId: 'engineering-thermal' })
  const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }
  const invoke = async (operation: string, input: unknown, key?: string) => {
    const capabilityId = `world.engineering.${operation}`
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, resource, input, ...(key ? { idempotencyKey: key } : {}), access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'human', id: 'engineering-api' } }) }) })
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw new Error('World did not answer engineering capability')
    return { status: response.status, body: await response.json() as { result?: any; error?: { code: string } } }
  }
  const selection = { profile: 'plant-thermal', subjectId: 'plant:engineering-thermal' }
  const capture = await invoke('inputs.capture', selection)
  expect(capture.status).toBe(200)
  const basis = engineeringInputBasisSchema.parse(capture.body.result)
  expect((await invoke('inputs.capture', selection, 'unsupported')).body.error?.code).toBe('idempotency_not_supported')
  const request = { ...selection, horizonSeconds: 1, variant: { label: 'Trip at origin', actions: [{ atSeconds: 0, path: 'manualReactorTrip.pushbutton', value: true }] } }
  expect((await invoke('continuation.submit', request)).body.error?.code).toBe('engineering_key_required')
  const submitted = await invoke('continuation.submit', request, 'one')
  expect(submitted.status).toBe(200)
  const { view, ...receipt } = submitted.body.result
  const parsed = engineeringContinuationReceiptSchema.parse(receipt)
  expect(view).toEqual({ viewType: 'engineering.continuation', title: 'Engineering comparison', height: 650, state: JSON.stringify({ jobId: parsed.jobId }) })
  expect((await invoke('continuation.submit', request, 'one')).body.result.jobId).toBe(parsed.jobId)
  expect((await invoke('continuation.inspect', { jobId: parsed.jobId })).status).toBe(200)
  expect((await invoke('continuation.cancel', { jobId: parsed.jobId })).body.result.status).toBe('cancelled')
  await run.setAgentRestrictions({ id: actorIdSchema.parse('actor:test'), label: 'Controller', role: 'controller' }, { operationIds: [], objects: [{ objectId: objectIdSchema.parse(selection.subjectId), deny: ['inspect'] }] }, 0)
  expect((await invoke('continuation.inspect', { jobId: parsed.jobId })).status).toBe(409)
  const { epoch, scenarioDigest, restrictionRevision } = basis.frame
  expect((await invoke('inputs.qualify', { ...selection, profileRevision: basis.profileRevision, frame: { epoch, scenarioDigest, restrictionRevision } })).body.result.allowed).toBe(false)
}, 60_000)
