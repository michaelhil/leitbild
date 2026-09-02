import { newWorkspaceId } from '@leitbild/contracts'
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actorIdSchema, geoPointFromLonLat, objectContextSchema } from '../src/core/model/index.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationClockReader } from '../src/core/model/time.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testPacks, testScenarioAuthoring } from './helpers.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'

const definition = () => scenarioDefinitionSchema.parse({ id: 'authoring-test', title: 'Authoring test', packs: [{ id: 'ambulance', config: {}, items: [] }], world: { startsAt: '2000-01-01T00:00:00.000Z' }, view: { map: { center: [11.4, 59.1], zoom: 12 } } })
const withRegistry = async (testBody: (registry: ReturnType<typeof createSimulationRunRegistry>) => Promise<void>) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-authoring-regressions-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  try { await testBody(registry) }
  finally { for (const run of registry.list()) await registry.close(run.id); await rm(dataDir, { recursive: true, force: true }) }
}

test('all five real Packs share one paused startup clock and preserve progress through controls and restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-shared-clock-'))
  const clocks: SimulationClockReader[] = []
  const adapters = createTestPackRuntimeAdapters().map(adapter => ({
    ...adapter,
    connect: async (config: Parameters<typeof adapter.connect>[0]) => {
      if (!config.runClock) throw new Error('Run did not supply its clock')
      expect(config.runClock.read().paused).toBe(true)
      clocks.push(config.runClock)
      return adapter.connect(config)
    },
  }))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), ...testScenarioAuthoring(), runtimeAdapters: adapters, scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  try {
    const source = structuredClone(testScenarioDefinitions.find(source => source.id === 'halden-power-complex')!)
    source.id = 'all-packs-clock'
    source.packs.push(
      { id: 'ambulance', config: {}, items: [{ id: 'ambulance:clock' as never, type: 'ambulance', label: 'Ambulance', position: [11.48, 59.08] }] },
      { id: 'drone', config: {}, items: [{ id: 'drone:clock' as never, type: 'drone', label: 'Drone', position: [11.48, 59.08], modelId: 'native-survey-quad', altitudeM: 35, headingDeg: 0 }] },
    )
    await registry.createScenario(source)
    const run = await registry.create({ scenarioId: source.id })
    expect(clocks).toHaveLength(5)
    expect(new Set(clocks).size).toBe(1)
    await run.setClock({ speed: 2 })
    await Bun.sleep(40)
    await run.setClock({ paused: true })
    const frozen = run.snapshot().clock!.currentTime
    expect(Date.parse(frozen)).toBeGreaterThan(Date.parse(source.world.startsAt))
    expect(clocks.every(clock => clock.read().currentTime === frozen && clock.read().paused)).toBe(true)
    expect(run.snapshot().objects).toHaveLength(10)
    await Bun.sleep(30)
    expect(run.snapshot().clock!.currentTime).toBe(frozen)
    await registry.close(run.id)
    clocks.length = 0
    const restored = await registry.load(run.id)
    expect(restored.snapshot().clock!.currentTime).toBe(frozen)
    expect(restored.snapshot().objects).toHaveLength(10)
    expect(clocks).toHaveLength(5)
    expect(new Set(clocks).size).toBe(1)
    expect(clocks.every(clock => clock.read().currentTime === frozen && clock.read().paused)).toBe(true)
  } finally {
    for (const run of registry.list()) await registry.close(run.id)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('save/preview reject unknown runtime, profile, command and missing conditional provider', async () => withRegistry(async registry => {
  const source = definition()
  const invalid = [
    { ...source, packs: [{ ...source.packs[0]!, runtime: 'missing-runtime' }] },
    { ...source, packs: [{ ...source.packs[0]!, recording: { profileId: 'missing-profile' } }] },
    { ...source, packs: [{ ...source.packs[0]!, config: { roadWeather: { enabled: true } } }] },
    { ...source, timeline: { cues: [{ id: 'invalid', at: { kind: 'after_scenario_start' as const, seconds: 1 }, actions: [{ type: 'invoke_capability' as const, capabilityId: 'world.weather.update', input: {} }] }] } },
  ]
  for (const document of invalid) {
    await expect(registry.previewScenario(document)).rejects.toThrow()
    await expect(registry.createScenario(document)).rejects.toThrow()
  }
  expect(await registry.currentScenario(source.id)).toBeUndefined()
}))

test('forward asset references are independent of item order and core context survives strict Pack parsing', async () => {
  const source = definition()
  source.packs[0]!.items = [
    { type: 'ambulance', id: 'ambulance:forward' as never, label: 'Forward', atObject: 'hospital:later', targetId: 'hospital:later', context: objectContextSchema.parse({ schemaVersion: 1 }) },
    { type: 'hospital', id: 'hospital:later' as never, label: 'Later hospital', position: [11.4, 59.1], traumaBeds: { total: 10, available: 10 } },
  ]
  const compiled = await compileScenarioDefinition(source, testPacks, { routing: createDirectRoutingAdapter() })
  const ambulance = compiled.initialObjects.find(object => object.id === 'ambulance:forward')!
  expect(ambulance.context?.schemaVersion).toBe(1)
  expect(ambulance.spatial.position?.point).toEqual(geoPointFromLonLat(11.4, 59.1))
  source.packs[0]!.items.pop()
  await expect(compileScenarioDefinition(source, testPacks, { routing: createDirectRoutingAdapter() })).rejects.toThrow('hospital:later')
})

test('same-time cues follow authored order, modify live incident state and do not replay after restore', async () => withRegistry(async registry => {
  const source = definition()
  source.packs[0]!.items = [{ type: 'ambulance', id: 'ambulance:one' as never, label: 'Ambulance', position: [11.4, 59.1] }]
  source.timeline = { cues: [
    { id: 'z-create-first', at: { kind: 'after_scenario_start', seconds: 0 }, actions: [{ type: 'invoke_capability', capabilityId: 'world.ambulance.create-incident', input: { id: 'incident:live', label: 'Live incident', position: [11.41, 59.1], triage: 'red', victims: { state: 'unknown' } } }] },
    { id: 'a-update-second', at: { kind: 'after_scenario_start', seconds: 0 }, actions: [{ type: 'invoke_capability', capabilityId: 'world.ambulance.set-incident-victims', input: { objectId: 'incident:live', victims: { state: 'confirmed', count: 3 } } }] },
  ] }
  await registry.createScenario(source)
  const run = await registry.create({ scenarioId: source.id })
  await run.setClock({ paused: true, speed: 3 })
  expect(run.snapshot().scenario!.timeline!.firedCueIds).toEqual(['z-create-first', 'a-update-second'])
  const actor = { id: actorIdSchema.parse('test:operator'), label: 'Operator', role: 'system' as const }
  await run.invokeCapability(actor, { capabilityId: 'world.ambulance.assign-to-incident', input: { ambulanceId: 'ambulance:one', incidentId: 'incident:live' } })
  const before = run.snapshot().objects.find(object => object.id === 'incident:live')!
  const changed = await run.invokeCapability(actor, { capabilityId: 'world.ambulance.set-incident-victims', input: { objectId: 'incident:live', victims: { state: 'confirmed', count: 7 } } })
  expect(changed.kind === 'command' && changed.result.ok).toBe(true)
  const after = run.snapshot().objects.find(object => object.id === 'incident:live')!
  expect(after.operational).toEqual(before.operational)
  expect(after.tasking).toEqual(before.tasking)
  expect((after.packData as { victims: { count: { value: number } } }).victims.count.value).toBe(7)
  expect(Date.parse(after.timestamps.createdAt)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'))
  const clock = run.snapshot().clock!
  await Bun.sleep(30)
  expect(run.snapshot().clock!.currentTime).toBe(clock.currentTime)
  const id = run.id
  await registry.close(id)
  const restored = await registry.load(id)
  expect(restored.snapshot().clock!.currentTime).toBe(clock.currentTime)
  expect(restored.snapshot().scenario!.timeline!.firedCueIds).toEqual(['z-create-first', 'a-update-second'])
  expect((restored.snapshot().objects.find(object => object.id === 'incident:live')!.packData as { victims: { count: { value: number } } }).victims.count.value).toBe(7)
}))
