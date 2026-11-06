import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly, worldPacks } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import type { SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { PackRuntimeAdapter } from '../src/simulation/protocol.ts'
import offsite from '../src/scenarios/halden-offsite-power-restoration.scenario.json'
import supply from '../src/scenarios/supply-run.scenario.json'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { answerDroneQuery, droneSensorContactsQueryKind } from '../src/packs/drone/query.ts'
import { createQueryReadPolicy, unrestrictedQueryReadPolicy } from '../src/simulation/query-read-policy.ts'
import { validateWorldAssembly } from '../src/core/packs/assembly.ts'
import { rawObjectReadPolicy } from '../src/core/packs/inspection.ts'

const operator = { id: actorIdSchema.parse('actor:policy-person'), label: 'Policy person', role: 'operator' as const }
const smallSource = () => scenarioDefinitionSchema.parse({
  id: 'read-policy', title: 'Read policy', world: { startsAt: '2026-01-01T00:00:00.000Z' }, view: { map: { center: [11.4, 59.1], zoom: 12 } },
  packs: [
    { id: 'drone', config: {}, items: [
      { type: 'drone', id: 'drone:visible', label: 'Visible', position: [11.4, 59.1] },
      { type: 'drone', id: 'drone:hidden', label: 'Hidden drone', position: [11.4001, 59.1] },
    ] },
    { id: 'ambulance', config: {}, items: [
      { type: 'incident', id: 'incident:hidden', label: 'Hidden incident', summary: 'Hidden incident detail', dispatchUrgency: 'urgent', position: [11.4002, 59.1] },
      { type: 'incident', id: 'incident:visible', label: 'Visible incident', summary: 'Visible detail', dispatchUrgency: 'ordinary', position: [11.4003, 59.1] },
      { type: 'patient', id: 'patient:hidden', label: 'Hidden patient', incidentId: 'incident:hidden', summary: 'Test demand', assessedUrgency: 'urgent', needs: [] },
      { type: 'ambulance', id: 'ambulance:visible', label: 'Busy visible unit', position: [11.4, 59.1], patientCapacity: 1, capabilities: [], crewReady: true, mobilizationSeconds: 120, sceneSeconds: 900 },
    ] },
    { id: 'situation-monitor', config: { sources: [] }, items: [] },
  ],
})

const withWorld = async (body: (context: {
  registry: SimulationRunRegistry
  invoke: (runId: string, capabilityId: string, input: unknown, actor?: 'ai' | 'human') => Promise<{ status: number; body: any }>
}) => Promise<void>, wrap?: (adapter: PackRuntimeAdapter) => PackRuntimeAdapter) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-read-policy-'))
  const workspaceId = newWorkspaceId(), routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    runtimeAdapters: wrap ? assembly.runtimeAdapters.map(wrap) : assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: [],
    compileScenarioDefinition: source => compileScenarioDefinition(source, worldPacks, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldPacks),
  })
  try {
    await workspaces.provision(workspaceId)
    const registry = (await workspaces.getOrLoad(workspaceId)).simulationRuns
    const invoke = async (runId: string, capabilityId: string, input: unknown, actor: 'ai' | 'human' = 'ai') => {
      const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: actor, id: `policy-${actor}` } })
      const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, input, access, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId } }),
      })
      const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
      if (!response) throw Error('Module did not handle the read')
      return { status: response.status, body: await response.json() }
    }
    await body({ registry, invoke })
  } finally { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
}

test('published Pack reads filter before relations, contacts, totals and pages; safe source summaries and person reads remain usable', async () => withWorld(async ({ registry, invoke }) => {
  const source = smallSource()
  source.packs[0]!.items[0]!.modelId = 'incident-response-quadcopter'
  await registry.createScenario(source)
  const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
  expect((await run.invokeCapability(operator, { capabilityId: 'world.ambulance.assign', input: { unitId: 'ambulance:visible', incidentId: 'incident:hidden', patientIds: ['patient:hidden'] } })).kind).toBe('command')
  const observed = await run.invokeCapability(operator, { capabilityId: 'world.drone.observe-target', input: { droneId: 'drone:visible', targetId: 'incident:hidden' } })
  expect(observed).toMatchObject({ kind: 'command', result: { ok: true } })
  await run.setAgentRestrictions(operator, { operationIds: [], objects: ['drone:hidden', 'incident:hidden', 'patient:hidden'].map(id => ({ objectId: objectIdSchema.parse(id), deny: ['inspect'] })) }, 0)
  for (const [id, input] of [
    ['world.drone.scene', {}], ['world.drone.controller-bindings', {}], ['world.drone.sensor-contacts', { droneId: 'drone:visible' }],
    ['world.ambulance.dispatch-state', { limit: 1 }], ['world.ambulance.metrics', {}], ['world.simulation-run.objects.search', {}], ['world.simulation-run.inspect', {}], ['world.simulation-run.changes', { afterSequence: 0, limit: 500 }],
  ] as const) {
    const answer = await invoke(run.id, id, input)
    expect(answer.status).toBe(200)
    expect(JSON.stringify(answer.body)).not.toContain('drone:hidden')
    expect(JSON.stringify(answer.body)).not.toContain('incident:hidden')
    expect(JSON.stringify(answer.body)).not.toContain('patient:hidden')
  }
  const dispatch = (await invoke(run.id, 'world.ambulance.dispatch-state', {})).body.result
  expect(dispatch.totals).toEqual({ units: 1, incidents: 1, patients: 0, careSites: 0 })
  expect(dispatch.units[0].phase).toBe('mobilizing')
  expect(dispatch.units[0].planRestricted).toBe(true)
  expect(dispatch.units[0].activeStopIndex).toBeNull()
  expect(dispatch.units[0].stops).toEqual([])
  expect(dispatch.units[0].assignmentWarnings).toEqual([expect.stringContaining('restricted')])
  expect((await invoke(run.id, 'world.ambulance.object', { objectId: 'incident:hidden' })).status).toBe(403)
  expect((await invoke(run.id, 'world.ambulance.dispatch-state', { incidentId: 'incident:hidden' })).status).toBe(403)
  expect((await invoke(run.id, 'world.simulation-run.read-object', { objectId: 'ambulance:visible' })).status).toBe(403)
  const person = await invoke(run.id, 'world.ambulance.dispatch-state', {}, 'human')
  expect(person.body.result.totals.incidents).toBe(2)
  expect(JSON.stringify(person.body)).toContain('incident:hidden')
  expect((await invoke(run.id, 'world.situation-monitor.status', {})).status).toBe(200)
  await registry.close(run.id)
  const restored = await registry.load(run.id)
  expect((await invoke(restored.id, 'world.drone.scene', {})).body.result.drones.map((drone: any) => drone.id)).toEqual(['drone:visible'])
}))

test('dense Drone contacts expose partial coverage and stable continuation after visibility filtering', async () => withWorld(async ({ registry }) => {
  const source = smallSource(); await registry.createScenario(source)
  const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
  const drone = run.snapshot().objects.find(object => object.id === 'drone:visible')!
  const targets = Array.from({ length: 501 }, (_, index) => ({ ...drone, id: objectIdSchema.parse(`target:${String(index).padStart(3, '0')}`), label: `Target ${index}` }))
  const query = (objects: typeof targets, input: unknown, hidden: string[] = []) => answerDroneQuery({ objects: [drone, ...objects], request: { capabilityId: droneSensorContactsQueryKind, input, readPolicy: createQueryReadPolicy(`test:${hidden.join(',')}`, hidden) } }) as any
  const first = query(targets, { droneId: drone.id })
  expect(first.contacts).toHaveLength(500)
  expect(first.hasMore).toBe(true)
  expect(first.nextAfter).toEqual({ droneId: drone.id, targetId: 'target:499' })
  const last = query([...targets].reverse(), { droneId: drone.id, after: first.nextAfter })
  expect(last).toMatchObject({ contacts: [{ targetId: 'target:500' }], hasMore: false, nextAfter: null })
  const filtered = query(targets, { droneId: drone.id }, ['target:100'])
  expect(filtered.contacts).toHaveLength(500)
  expect(filtered.hasMore).toBe(false)
  expect(JSON.stringify(filtered)).not.toContain('target:100')

  const one = { ...drone, id: objectIdSchema.parse('one'), context: { schemaVersion: 1 as const, facts: [], activity: [], summaries: [], references: [{ kind: 'object' as const, id: 'two' }] } }
  const two = { ...drone, id: objectIdSchema.parse('two'), context: { ...one.context, references: [{ kind: 'object' as const, id: 'one' }, { kind: 'object' as const, id: 'deleted-secret' }] } }
  const policy = rawObjectReadPolicy(createQueryReadPolicy('cycle', ['deleted-secret']), [drone, one, two], worldPacks)
  expect(policy.canInspect('one')).toBe(false)
  expect(policy.canInspect('two')).toBe(false)
  expect(policy.canInspect(drone.id)).toBe(true)
}))

test('Einsatz recommendations filter candidates before routing; merged Weather refuses only unsupported restricted-derived reads', async () => withWorld(async ({ registry, invoke }) => {
  const source = scenarioDefinitionSchema.parse({ ...supply, id: 'einsatz-policy', timeline: undefined })
  await registry.createScenario(source)
  const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
  await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:truck-4'), deny: ['inspect'] }] }, 0)
  const recommendation = await invoke(run.id, 'world.einsatz.recommend', { taskId: 'task:field-kitchen' })
  expect(recommendation.status).toBe(200)
  expect(JSON.stringify(recommendation.body)).not.toContain('unit:truck-4')
  expect(JSON.stringify(recommendation.body)).toContain('unit:truck-3')
  expect((await invoke(run.id, 'world.einsatz.configuration', {})).status).toBe(200)

  const weather = smallSource()
  weather.id = 'weather-policy'
  const defaults = weatherPack.authoring!.itemTypes.find(item => item.id === 'weather_area')!.defaultItem
  weather.packs.push({ id: 'weather', config: {}, items: [{ ...defaults, type: 'weather_area', id: objectIdSchema.parse('weather:hidden'), label: 'Hidden forcing', center: [11.4, 59.1] }] })
  await registry.createScenario(weather)
  const weatherRun = await registry.create({ scenarioId: weather.id }); await weatherRun.setClock({ paused: true })
  await weatherRun.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('weather:hidden'), deny: ['inspect'] }] }, 0)
  const input = { point: { type: 'Point', coordinates: [11.4, 59.1] } }
  expect(await invoke(weatherRun.id, 'world.weather.sample-at-point', input)).toMatchObject({ status: 403, body: { error: { code: 'query_read_scope_unavailable' } } })
  expect((await invoke(weatherRun.id, 'world.weather.describe', {})).status).toBe(200)
  expect((await invoke(weatherRun.id, 'world.weather.sample-at-point', input, 'human')).status).toBe(200)
  expect(weatherRun.health().every(health => health.state === 'ready')).toBe(true)
}))

test('every assembled runtime query explicitly declares read scope; an omitted classification is rejected before use', () => {
  const assembly = createWorldApplicationAssembly({ routing: createDirectRoutingAdapter() })
  for (const capability of assembly.runtimeAdapters.flatMap(adapter => adapter.capabilities).filter(capability => capability.kind === 'query')) {
    expect(['catalog', 'object', 'collection']).toContain(capability.readScope!)
  }
  const adapter = assembly.runtimeAdapters.find(adapter => adapter.packId === 'drone')!
  const query = adapter.capabilities.find(capability => capability.kind === 'query')!
  const { readScope: _readScope, ...unclassified } = query
  expect(() => validateWorldAssembly({ packs: assembly.packs, runtimeAdapters: assembly.runtimeAdapters.map(candidate => candidate === adapter ? { ...adapter, capabilities: adapter.capabilities.map(capability => capability === query ? unclassified : capability) } : candidate) })).toThrow('must declare its read scope')
  expect(unrestrictedQueryReadPolicy.canInspect('not-denied')).toBe(true)
})

test('an asynchronous query cannot return under a superseded AI policy, while human and later reads recover', async () => {
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let delay = true
  await withWorld(async ({ registry, invoke }) => {
    const source = smallSource(); await registry.createScenario(source)
    const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
    const pending = invoke(run.id, 'world.drone.scene', {})
    await waiting
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('drone:hidden'), deny: ['inspect'] }] }, 0)
    release()
    expect(await pending).toMatchObject({ status: 409, body: { error: { code: 'query_policy_superseded' } } })
    expect((await invoke(run.id, 'world.drone.scene', {})).body.result.drones).toHaveLength(1)
    expect((await invoke(run.id, 'world.drone.scene', {}, 'human')).body.result.drones).toHaveLength(2)
    expect(run.health().every(health => health.state === 'ready')).toBe(true)
  }, adapter => adapter.packId !== 'drone' ? adapter : { ...adapter, connect: async config => {
    const connection = await adapter.connect(config)
    return { ...connection, invokeQuery: async query => {
      if (delay && query.capabilityId === 'world.drone.scene') { delay = false; entered(); await gate }
      return connection.invokeQuery(query)
    } }
  } })
})

test('a suspended AI read retains its caller policy while a person reads the same runtime', async () => {
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let delay = true
  await withWorld(async ({ registry, invoke }) => {
    const source = smallSource(); await registry.createScenario(source)
    const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('drone:hidden'), deny: ['inspect'] }] }, 0)
    const pending = invoke(run.id, 'world.drone.scene', {})
    await waiting
    const person = await invoke(run.id, 'world.drone.scene', {}, 'human')
    expect(person.status).toBe(200)
    expect(person.body.result.drones).toHaveLength(2)
    release()
    const ai = await pending
    expect(ai.status).toBe(200)
    expect(ai.body.result.drones.map((drone: any) => drone.id)).toEqual(['drone:visible'])
  }, adapter => adapter.packId !== 'drone' ? adapter : { ...adapter, connect: async config => {
    const connection = await adapter.connect(config)
    return { ...connection, invokeQuery: async query => {
      if (delay && query.capabilityId === 'world.drone.scene') { delay = false; entered(); await gate }
      return connection.invokeQuery(query)
    } }
  } })
})

test('Plant, Grid, retained layout and history reads do not rediscover a restricted owner through other projections', async () => withWorld(async ({ registry, invoke }) => {
  const source = scenarioDefinitionSchema.parse({ ...offsite, id: 'owner-policy', timeline: undefined })
  await registry.createScenario(source)
  const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
  const hidden = objectIdSchema.parse('plant:halden-1')
  await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: hidden, deny: ['inspect'] }] }, 0)
  for (const [id, input] of [
    ['world.process-plant.plants.list', {}], ['world.process-plant.runtime.status', {}], ['world.process-plant.signals.search', { text: 'level', limit: 2 }],
    ['world.electric-grid.connection-points.list', { gridId: 'grid:halden-four-unit' }], ['world.simulation-run.inspect', {}], ['world.simulation-run.changes', { afterSequence: 0, limit: 500 }],
  ] as const) {
    const result = await invoke(run.id, id, input)
    expect(result.status).toBe(200)
    expect(JSON.stringify(result.body)).not.toContain(hidden)
  }
  expect((await invoke(run.id, 'world.simulation-run.read-object', { objectId: 'layout:halden-1' })).status).toBe(403)
  expect((await invoke(run.id, 'world.process-plant.catalog.list', {})).status).toBe(200)
  const person = await invoke(run.id, 'world.process-plant.plants.list', {}, 'human')
  expect(person.body.result.plants).toHaveLength(4)
  await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('grid:halden-four-unit'), deny: ['inspect'] }] }, 1)
  const grids = await invoke(run.id, 'world.electric-grid.catalog.list', {})
  expect(grids.body.result.grids).toEqual([])
  expect(grids.body.result.models.length).toBeGreaterThan(0)
}))

test('a suspended AI query refuses a changed restriction revision', async () => {
  let entered!: () => void, release!: () => void, delay = false
  const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  await withWorld(async ({ registry }) => {
    const source = smallSource(); await registry.createScenario(source)
    const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
    const actor = { ...operator, id: actorIdSchema.parse('actor:ai:policy-read'), role: 'ai_agent' as const }
    delay = true
    const pending = run.invokeCapability(actor, { capabilityId: 'world.drone.scene', input: {} })
    await waiting
    await run.setAgentRestrictions(operator, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('drone:hidden'), deny: ['inspect'] }] }, 0)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'query_policy_superseded' })
  }, adapter => adapter.packId !== 'drone' ? adapter : { ...adapter, connect: async config => {
    const connection = await adapter.connect(config)
    return { ...connection, invokeQuery: async query => {
      if (delay && query.capabilityId === 'world.drone.scene') { delay = false; entered(); await gate }
      return connection.invokeQuery(query)
    } }
  } })
})
