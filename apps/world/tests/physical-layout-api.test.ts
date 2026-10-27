import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { currentPwrPhysicalDesignRef } from '../src/packs/physical-layout/design.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { layoutLiveResponseSchema } from '../src/ui/physical-layout/read-model.ts'
import { physicalSubjectStatus } from '../src/ui/physical-layout/status.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { ObservationPort } from '../src/features/displays/observation/port.ts'
import { createRoleRunRegistry } from './fixtures/role-runs.ts'
import { actorIdSchema, type IsoTimestamp } from '../src/core/model/index.ts'

const packs = [processPlantPack, physicalLayoutPack]
const definition = scenarioDefinitionSchema.parse({ id: 'layout-api-proof', title: 'Layout API proof', packs: [
  { id: 'process-plant', config: {}, items: [{ type: 'plant', id: 'plant:proof', label: 'Current PWR', location: [11.47, 59.087], model: { ref: 'process-plant.pwr.reference', parameters: { loopCount: 4 } }, operatingPoint: { ref: 'process-plant.pwr.full-power' }, automation: { ref: 'process-plant.pwr.standard' } }] },
  { id: 'physical-layout', config: {}, items: [{ type: 'site-layout', id: 'layout:proof', label: 'Turbine island', design: currentPwrPhysicalDesignRef, members: { unit: 'plant:proof' }, bearing: 0 }] },
], world: { startsAt: '2026-10-24T00:00:00Z' }, view: { map: { center: [11.47, 59.087], zoom: 16 } } })
const input = { layoutObjectId: 'layout:proof', expectedRevision: currentPwrPhysicalDesignRef.digest }
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const route = async (registry: SimulationRunRegistry, id: string, body: unknown = input, actor: 'anonymous' | 'ai' = 'anonymous', suffix = '') => {
  const request = new Request(`http://leitbild.test/api/workspaces/${registry.workspaceId}/world/simulation-runs/${id}/displays/layout${suffix}`, post(body))
  const response = await handleSimulationRunApi(request, new URL(request.url), { registry, accessContext: accessContextSchema.parse({ workspaceId: registry.workspaceId, requestId: newRequestId(), actor: actor === 'ai' ? { kind: 'ai', id: 'agent:proof' } : { kind: 'anonymous' } }), roleHolders: () => ({}) })
  if (!response) throw new Error('Layout route was not handled')
  return { status: response.status, body: await response.json() as unknown }
}
const withRun = async (work: (registry: SimulationRunRegistry, run: SimulationRunRuntime) => Promise<void>): Promise<void> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-layout-api-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [definition], compileScenarioDefinition: source => compileScenarioDefinition(source, packs, { routing: createDirectRoutingAdapter() }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs), scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }), runtimeAdapters: [createLocalProcessPlantPackRuntimeAdapter()] })
  try { const run = await registry.create({ scenarioId: definition.id }); await run.setClock({ paused: true }); await work(registry, run) }
  finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
}
const wrapObservations = (run: SimulationRunRuntime, read: (original: ObservationPort) => ObservationPort) => {
  const original = run.observations.bind(run)
  return spyOn(run, 'observations').mockImplementation(actor => read(original(actor)))
}
const errorCode = (body: unknown): string | undefined => (body as { error?: { code?: string } }).error?.code

describe('Real PWR layout display boundary', () => {
  test('one real owner acquisition parses in the exact UI schema and retains owner quality, labels and epoch', async () => withRun(async (registry, run) => {
    let reads = 0
    const spy = wrapObservations(run, original => ({ ...original, read: async request => { reads++; return original.read(request) } }))
    try {
      const response = await route(registry, run.id)
      expect(response.status).toBe(200)
      const parsed = layoutLiveResponseSchema.parse(response.body)
      expect(parsed.scope).toMatchObject({ runId: run.id, layoutObjectId: 'layout:proof', revision: currentPwrPhysicalDesignRef.digest, objectId: 'plant:proof', packId: 'process-plant', modelDigest: '47b82339adddd913ef20d24294ae9c595b104d1c10148bcfb5943bc30aeaf3ea', sequence: run.snapshot().seq })
      expect(parsed.subjects).toHaveLength(7)
      expect(parsed.sample.observations.length).toBeGreaterThan(0)
      expect(parsed.sample.at).toMatchObject({ at: run.snapshot().clock!.currentTime, clock: 'simulation', paused: true })
      expect(reads).toBe(1)
      expect(parsed.subjects.every(subject => subject.values.every(value => value.ref.startsWith('plant:proof#')))).toBe(true)
      const acquired = new Set(parsed.sample.observations.map(observation => observation.ref))
      expect(parsed.subjects.every(subject => subject.values.length <= 8 && subject.values.every(value => acquired.has(value.ref)))).toBe(true)
      const semantic = parsed.subjects.flatMap(subject => subject.topology ? [subject.topology] : [])
      expect(semantic.length).toBeGreaterThan(0)
      expect(semantic.every(topology => topology.values.every(value => acquired.has(value.ref)))).toBe(true)
      expect(semantic.flatMap(topology => topology.bindings).some(binding => binding.role === 'running' || binding.role === 'conducting')).toBe(true)
      const condenser = parsed.subjects.find(subject => subject.elementId === 'condenser')!
      expect(physicalSubjectStatus({ subject: { objectId: parsed.scope.objectId, packId: parsed.scope.packId, elementId: condenser.elementId, label: condenser.label }, values: condenser.values, observations: parsed.sample.observations }, parsed.sample.alerts, false).quality).toBe('good')
      const second = layoutLiveResponseSchema.parse((await route(registry, run.id)).body)
      expect(second.scope.epoch).toBe(parsed.scope.epoch)
      expect(second.scope.sequence).toBe(parsed.scope.sequence)
    } finally { spy.mockRestore() }
  }))

  test('closed Run stays closed, AI is refused and a stale revision reads no owner data', async () => withRun(async (registry, run) => {
    let reads = 0
    const observations = wrapObservations(run, original => ({ ...original, read: async request => { reads++; return original.read(request) } }))
    try {
      const stale = await route(registry, run.id, { ...input, expectedRevision: 'wrong-revision' })
      expect(stale.status).toBe(409)
      expect(errorCode(stale.body)).toBe('layout_revision_mismatch')
      expect(reads).toBe(0)
      const ai = await route(registry, run.id, input, 'ai')
      expect(ai.status).toBe(403)
      expect(errorCode(ai.body)).toBe('display_route_for_people')
      const forged = await route(registry, run.id, { ...input, objectId: 'plant:unbound', subjectIds: ['core'] })
      expect(forged.status).toBe(400)
      await registry.close(run.id)
      const load = spyOn(registry, 'load')
      try {
        const closed = await route(registry, run.id)
        expect(closed.status).toBe(409)
        expect(errorCode(closed.body)).toBe('simulation_run_not_loaded')
        expect(registry.get(run.id)).toBeUndefined()
        expect(load).not.toHaveBeenCalled()
      } finally { load.mockRestore() }
    } finally { observations.mockRestore() }
  }))

  test('role gates precede layout resolution', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const run = await registry.create({ scenarioId: 'role-run' })
      const unroled = await route(registry, run.id)
      expect(unroled.status).toBe(403)
      expect(errorCode(unroled.body)).toBe('role_required')
      const unknown = await route(registry, run.id, input, 'anonymous', '?roles=ghost')
      expect(unknown.status).toBe(400)
      expect(errorCode(unknown.body)).toBe('unknown_role')
    } finally { await registry.shutdown() }
  })

  test('changed model is refused before any live observation read', async () => withRun(async (registry, run) => {
    const original = run.packs()
    const packsSpy = spyOn(run, 'packs').mockImplementation(() => original.map(pack => pack.descriptor.id !== 'process-plant' ? pack : { ...pack, physicalTargets: async object => ({ ...await processPlantPack.physicalTargets!(object), modelDigest: '0'.repeat(64) }) }))
    let reads = 0
    const observations = wrapObservations(run, original => ({ ...original, read: async request => { reads++; return original.read(request) } }))
    try {
      const response = await route(registry, run.id)
      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('layout_model_mismatch')
      expect(reads).toBe(0)
    } finally { observations.mockRestore(); packsSpy.mockRestore() }
  }))

  test('owner stale quality reaches the real client status unchanged', async () => withRun(async (registry, run) => {
    const observations = wrapObservations(run, original => ({ ...original, read: async request => { const answer = await original.read(request); return { ...answer, observations: answer.observations.map(observation => ({ ...observation, quality: 'stale' as const })) } } }))
    try {
      const response = await route(registry, run.id)
      expect(response.status).toBe(200)
      const parsed = layoutLiveResponseSchema.parse(response.body)
      const subject = parsed.subjects.find(subject => subject.values.length > 0)!
      const status = physicalSubjectStatus({ subject: { objectId: parsed.scope.objectId, packId: parsed.scope.packId, elementId: subject.elementId, label: subject.label }, values: subject.values, observations: parsed.sample.observations }, parsed.sample.alerts, false)
      expect(status.quality).toBe('stale')
      expect(status.word).toBeNull()
    } finally { observations.mockRestore() }
  }))

  test('a real turbine trip and acknowledgement reach the layout through the shared owner alarm lifecycle', async () => withRun(async (registry, run) => {
    const operator = { id: actorIdSchema.parse('actor:layout-alarm-proof'), label: 'Layout alarm proof', role: 'operator' as const }
    const before = layoutLiveResponseSchema.parse((await route(registry, run.id)).body)
    expect(before.sample.alerts).toHaveLength(0)
    const outcome = await run.invokeCapability(operator, { capabilityId: 'world.process-plant.action.invoke', input: { plantId: 'plant:proof', actionId: 'turbine-trip', parameters: {} } })
    expect(outcome.kind).toBe('command')
    if (outcome.kind !== 'command') throw new Error('Turbine trip did not issue a command')
    expect(outcome.result.ok).toBe(true)
    const target = new Date(Date.parse(run.snapshot().clock!.currentTime) + 2_000).toISOString() as IsoTimestamp
    await run.runMaximumPace(target, { shouldStop: () => false, onProgress: () => undefined })
    await run.setClock({ paused: true })
    const tripped = layoutLiveResponseSchema.parse((await route(registry, run.id)).body)
    expect(tripped.sample.alerts.length).toBeGreaterThan(0)
    expect(tripped.scope.sequence).toBeGreaterThan(before.scope.sequence)
    expect(tripped.scope.epoch).toBe(before.scope.epoch)
    const row = tripped.sample.alerts.find(row => row.state === 'active-unack' && row.acknowledge !== undefined)
    if (!row?.acknowledge) throw new Error('Trip produced no acknowledgeable owner alarm')
    const acknowledged = await run.invokeCapability(operator, { capabilityId: row.acknowledge.capabilityId, input: row.acknowledge.input })
    expect(acknowledged.kind).toBe('command')
    const after = layoutLiveResponseSchema.parse((await route(registry, run.id)).body)
    expect(after.sample.alerts.find(candidate => candidate.key === row.key)?.state).toBe('active-ack')
    expect(after.sample.alerts).toHaveLength(tripped.sample.alerts.length)
    const owner = run.snapshot().objects.find(object => object.id === 'plant:proof')!
    expect(new Set(after.sample.alerts.map(row => row.alert.id))).toEqual(new Set(owner.alerts.map(alert => alert.id)))
  }))

  test('a mid-acquisition owner refusal does not become a successful partial status sample', async () => withRun(async (registry, run) => {
    const observations = wrapObservations(run, original => ({ ...original, read: async () => ({ observations: [], unknown: [], refused: [{ objectId: 'plant:proof' as never, refused: { code: 'role_required', message: 'Owner read denied during acquisition' } }], leads: [] }) }))
    try {
      const response = await route(registry, run.id)
      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('layout_observation_refused')
    } finally { observations.mockRestore() }
  }))

  test('an unknown requested owner ref does not silently disappear from a successful sample', async () => withRun(async (registry, run) => {
    const observations = wrapObservations(run, original => ({ ...original, read: async request => {
      const result = await original.read(request), missing = result.observations[0]!.ref
      return { ...result, observations: result.observations.slice(1), unknown: [missing] }
    } }))
    try {
      const response = await route(registry, run.id)
      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('layout_observation_unknown')
    } finally { observations.mockRestore() }
  }))

  test('an omitted selected reading is refused even if the owner forgets to mark it unknown', async () => withRun(async (registry, run) => {
    const observations = wrapObservations(run, original => ({ ...original, read: async request => {
      const result = await original.read(request)
      return { ...result, observations: result.observations.slice(1) }
    } }))
    try {
      const response = await route(registry, run.id)
      expect(response.status).toBe(409)
      expect(errorCode(response.body)).toBe('layout_observation_missing')
    } finally { observations.mockRestore() }
  }))

  test('the API lease blocks reset during acquisition, and a later reset changes the confirmed epoch', async () => withRun(async (registry, run) => {
    const first = layoutLiveResponseSchema.parse((await route(registry, run.id)).body)
    let release!: () => void, entered!: () => void
    const enteredRead = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const observations = wrapObservations(run, original => ({ ...original, read: async request => { const result = await original.read(request); entered(); await held; return result } }))
    try {
      const pending = route(registry, run.id)
      await enteredRead
      await expect(registry.reset(run.id)).rejects.toMatchObject({ code: 'simulation_run_busy' })
      release()
      const same = layoutLiveResponseSchema.parse((await pending).body)
      expect(same.scope.epoch).toBe(first.scope.epoch)
      const reset = await registry.reset(run.id)
      await reset.setClock({ paused: true })
      const current = layoutLiveResponseSchema.parse((await route(registry, reset.id)).body)
      expect(current.scope.epoch).not.toBe(first.scope.epoch)
    } finally { release(); observations.mockRestore() }
  }))
})
