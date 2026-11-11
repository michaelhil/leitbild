import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, moduleCapabilityCollectionSchema, newRequestId, newWorkspaceId, planningFactsOutputSchema } from '@leitbild/contracts'
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
const supplyRun = builtinScenarioDefinitions.find(source => source.id === 'supply-run')!
const { guide: _guide, ...supplyRunWithoutGuide } = supplyRun

test('planning facts are one published Run query: lazy, read-only, paged within 4 KB, with honest refusals', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'planning-facts-api-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const workspaces = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    scenarioDefinitions: [...builtinScenarioDefinitions, { ...supplyRunWithoutGuide, id: 'planning-facts-roles', roles: [{ id: 'control', label: 'Controller', class: 'controller' as const }] }],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
  })
  cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const workspaceId = newWorkspaceId()
  await workspaces.provision(workspaceId)
  const registry = workspaces.getLoaded(workspaceId)!.simulationRuns
  const call = async (path: string, init?: RequestInit) => {
    const request = new Request(`http://world.test${path}`, init)
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw new Error(`World did not answer ${path}`)
    return { status: response.status, text: await response.text() }
  }
  const invoke = async (runId: string, capabilityId: string, input: unknown, kind: 'human' | 'ai' = 'human') => {
    const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }
    const answer = await call(`/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, resource, input, access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind, id: 'planning-facts-api' } }) }),
    })
    const body = JSON.parse(answer.text) as { result?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } }
    return { status: answer.status, body, resultBytes: body.result === undefined ? 0 : Buffer.byteLength(JSON.stringify(body.result), 'utf8') }
  }
  const facts = (runId: string, input: unknown, kind: 'human' | 'ai' = 'human') => invoke(runId, 'world.simulation-run.planning-facts', input, kind)

  const listed = moduleCapabilityCollectionSchema.parse(JSON.parse((await call(`/internal/workspaces/${workspaceId}/capabilities`)).text)).capabilities
  const descriptor = listed.find(capability => capability.id === 'world.simulation-run.planning-facts')!
  expect(descriptor).toMatchObject({ kind: 'query', risk: 'read', scope: { kind: 'resource', resourceType: 'world.simulation-run' } })
  expect(descriptor.searchTerms).toEqual(['equipment', 'pump', 'crew', 'vehicle', 'truck', 'asset', 'find', 'availability', 'estimate', 'planning', 'state'])
  expect(descriptor.description.length).toBeGreaterThanOrEqual(300)
  expect(descriptor.description.length).toBeLessThanOrEqual(700)
  expect(descriptor.description).not.toMatch(/study|qualif|digest|epoch|profile|production ready/i)
  expect(Buffer.byteLength(JSON.stringify(descriptor.inputSchema), 'utf8')).toBeLessThanOrEqual(4_096)
  // The per-Pack planning reads and qualification are gone; the Pack projections stay World's own.
  expect(listed.map(capability => String(capability.id)).filter(id => id.includes('planning'))).toEqual(['world.simulation-run.planning-facts'])

  const run = await registry.create({ scenarioId: 'supply-run' })
  const runResource = JSON.parse((await call(`/internal/workspaces/${workspaceId}/resources`)).text) as { resources: Array<{ ref: { type: string; id: string }; capabilityIds: string[] }> }
  expect(runResource.resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === run.id)!.capabilityIds).toContain('world.simulation-run.planning-facts')
  await registry.close(run.id)
  expect(registry.get(run.id)).toBeUndefined()
  // A closed Run loads when someone asks for its facts.
  const search = await facts(run.id, { text: 'truck' })
  expect(search.status).toBe(200)
  expect(registry.get(run.id)).toBeDefined()
  const events = registry.get(run.id)!.events().length
  const found = planningFactsOutputSchema.parse(search.body.result)
  expect(found.run).toEqual({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id })
  expect(found.items.map(item => item.label)).toEqual(['Truck 1', 'Truck 3', 'Truck 4'])
  expect(search.resultBytes).toBeLessThanOrEqual(4_096)
  const tasks = planningFactsOutputSchema.parse((await facts(run.id, { kind: 'task' })).body.result).items
  // Trucks and requests read together carry the arrival estimates between them.
  const subjects = [...found.items, ...tasks].map(item => item.locator)
  expect(subjects).toHaveLength(5)
  let cursor: string | undefined, pages = 0
  do {
    const page = await facts(run.id, { subjects, ...(cursor === undefined ? {} : { cursor }) }, 'ai')
    expect(page.status).toBe(200)
    expect(page.resultBytes).toBeLessThanOrEqual(4_096)
    cursor = planningFactsOutputSchema.parse(page.body.result).more
    pages++
  } while (cursor !== undefined)
  expect(pages).toBeGreaterThan(1)
  expect(registry.get(run.id)!.events()).toHaveLength(events)

  const unknown = await facts(run.id, { subjects: ['einsatz/unit/unit%3Anone'] })
  expect(unknown.status).toBe(404)
  expect(unknown.body.error).toMatchObject({ code: 'unknown_subject', details: { subjects: ['einsatz/unit/unit%3Anone'] } })
  expect((await facts(run.id, { text: 'truck', cursor: '0.0000000000000000.0000000000000000' })).body.error?.code).toBe('invalid_cursor')
  expect((await facts(run.id, { subjects, text: 'truck' })).status).toBe(400)
  expect((await invoke(run.id, 'world.einsatz.planning-basis', { detail: 'index' })).status).toBe(404)

  await registry.get(run.id)!.setAgentRestrictions({ id: actorIdSchema.parse('actor:controller'), label: 'Controller', role: 'controller' }, {
    operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:truck-1'), deny: ['inspect'] }],
  }, 0)
  expect((await facts(run.id, { text: 'truck' })).status).toBe(403)

  const roleRun = await registry.create({ scenarioId: 'planning-facts-roles' })
  expect((await facts(roleRun.id, {})).status).toBe(403)
  expect((await facts(roleRun.id, {}, 'ai')).status).toBe(403)
}, 120_000)
