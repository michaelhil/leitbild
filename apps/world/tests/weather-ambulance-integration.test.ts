import { describe,expect,test } from 'bun:test'
import { worldPacks } from '../src/app-assembly.ts'
import {
  commandEnvelopeSchema,
  nowIso,
  operationalObjectSchema,
  type CommandEnvelope,
  type SimulationRunEvent,
  type SimulationRunId,
} from '../src/core/model/index.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { roadWeatherImpact,roadWeatherPolicySchema } from '../src/packs/ambulance/road-weather.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { weatherItemSchema,weatherPackDataSchema } from '../src/packs/weather/model.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'

const routing = createDirectRoutingAdapter()
const source = builtinScenarioDefinitions.find((s) => s.id === 'halden-weather-response')!
const compiled = await compileScenarioDefinition(source, worldPacks, { routing })
const config = {
  simulationRunId: 'run-weather-integration' as SimulationRunId,
  scenario: {
    scenarioId: compiled.id,
    runtimeIds: ['weather.local', 'ambulance.local'],
    connections: [],
    world: compiled.world,
    initialObjects: compiled.initialObjects,
    runtimeConfigByRuntimeId: {
      'weather.local': source.packs.find((p) => p.id === 'weather')!.config,
      'ambulance.local': source.packs.find((p) => p.id === 'ambulance')!.config,
    },
    runtimeConfig: {},
  },
}
const command = (kind: string, payload: unknown): CommandEnvelope =>
  commandEnvelopeSchema.parse({
    id: 'command:' + crypto.randomUUID(),
    actorId: 'actor:test',
    simulationRunId: config.simulationRunId,
    issuedAt: nowIso(),
    targetObjectIds: [],
    kind,
    payload,
  }) as CommandEnvelope

describe('Weather ↔ Ambulance integration', () => {
  test('actual engine movement respects wet/ice/visibility policy, including a complete stop', () => {
    const vehicle = compiled.initialObjects.find((o) => o.kind === 'mobile_entity')!
    const sample = {
      state: { atmosphere: { visibilityM: 100 }, surface: { wetness: 0, ice: 0, snow: 0 } },
      quality: { validAt: compiled.world.startsAt },
    }
    const policy = roadWeatherPolicySchema.parse({ enabled: true, lowVisibilityFactor: 0 })
    const engine = createAmbulanceSimEngine({
      simulationRunId: config.simulationRunId,
      routing,
      objects: compiled.initialObjects.filter((o) => o.packId === 'ambulance'),
    })
    engine.setRoadWeatherImpact(vehicle.id, roadWeatherImpact(policy, sample))
    engine.tick(1000)
    const stopped = engine.snapshot().objects.find((o) => o.id === vehicle.id)!
    expect(stopped.spatial.position?.point).toEqual(vehicle.spatial.position?.point)
    expect(stopped.spatial.position?.speedMps).toBe(0)
    expect(stopped.spatial.route?.etaSeconds).toBeUndefined()
    operationalObjectSchema.parse(stopped)
    engine.setRoadWeatherImpact(vehicle.id, undefined)
    engine.tick(1000)
    const moving = engine.snapshot().objects.find((o) => o.id === vehicle.id)!
    expect(moving.spatial.position?.speedMps).toBeGreaterThan(0)
    expect(moving.spatial.position?.point).not.toEqual(stopped.spatial.position?.point)
  })
  test('typed provider reads affect real vehicles and area deletion removes only atmospheric forcing', async () => {
    const hub = createRuntimeHub([
      createLocalAmbulancePackRuntimeAdapter({ routing }),
      createLocalWeatherPackRuntimeAdapter(),
    ])
    const connection = await hub.connect(config)
    try {
      await connection.setClock({ currentTime: compiled.world.startsAt, updatedAt: nowIso(), paused: true, speed: 1 })
      const snapshot = await connection.getSnapshot()
      const vehicle = snapshot.objects.find((o) => o.kind === 'mobile_entity')!
      const initialImpact = vehicle.spatial.route?.impacts?.find(impact => impact.source.kind === 'runtime' && impact.source.id === 'ambulance.road-weather')
      expect(initialImpact?.speedFactor).toBe(0.5)
      const area = snapshot.objects.find((o) => o.id === 'weather:halden-front')!
      const old = weatherPackDataSchema.parse(area.packData)
      const definition = weatherItemSchema.parse({
        ...old.definition,
        center: vehicle.spatial.position!.point.coordinates,
        falloff: 'uniform',
        atmosphere: { visibilityM: 100 },
        keyframes: [],
      })
      expect(
        (
          await connection.sendCommand(
            command('world.weather.update', { item: definition, expectedRevision: area.revision }),
          )
        ).ok,
      ).toBe(true)
      expect(
        (
          await connection.sendCommand(
            command('world.ambulance.set-road-weather-policy', { enabled: true, lowVisibilityFactor: 0.25 }),
          )
        ).ok,
      ).toBe(true)
      const impacted = (await connection.getSnapshot()).objects.find((o) => o.id === vehicle.id)!
      expect(impacted.spatial.route?.impacts?.[0]?.speedFactor).toBe(0.25)
      expect(impacted.spatial.route?.impacts?.[0]?.source).toEqual({ kind: 'runtime', id: 'ambulance.road-weather' })
      await connection.observeCommittedEvents([
        {
          type: 'object.deleted',
          objectId: area.id,
          simulationRunId: config.simulationRunId,
          id: 'event:delete',
          seq: 1,
          at: nowIso(),
          provenance: { source: 'operator' },
        } as SimulationRunEvent,
      ])
      const cleared = (await connection.getSnapshot()).objects.find((o) => o.id === vehicle.id)!
      // Preset ground is still wet: removing the area is not a magic ground reset.
      expect(cleared.spatial.route?.impacts?.[0]?.speedFactor).toBeCloseTo(0.92)
      expect(
        (await connection.sendCommand(command('world.ambulance.set-road-weather-policy', { enabled: false }))).ok,
      ).toBe(true)
      expect((await connection.getSnapshot()).objects.find((o) => o.id === vehicle.id)!.spatial.route?.impacts).toEqual(
        [],
      )
      expect(connection.health?.().every((h) => h.state === 'ready')).toBe(true)
    } finally {
      await connection.close()
    }
  })
  test('standalone Ambulance works; an explicitly enabled missing provider rejects', async () => {
    const adapter = createLocalAmbulancePackRuntimeAdapter({ routing })
    const independent = {
      ...config,
      scenario: { ...config.scenario, runtimeIds: ['ambulance.local'], runtimeConfig: {} },
    }
    const connection = await adapter.connect(independent)
    await connection.close()
    await expect(
      adapter.connect({
        ...independent,
        scenario: { ...independent.scenario, runtimeConfig: { roadWeather: { enabled: true } } },
      }),
    ).rejects.toThrow('requires')
  })
})

test('combined restart preserves Weather ground and the configured vehicle policy', async () => {
  const saved = new Map<string, unknown>()
  const stores = Object.fromEntries(['weather.local', 'ambulance.local'].map(id => [id, {
    load: async () => saved.get(id) ?? null,
    save: async (value: unknown) => { saved.set(id, structuredClone(value)) },
  }]))
  const hub = createRuntimeHub([createLocalAmbulancePackRuntimeAdapter({ routing }), createLocalWeatherPackRuntimeAdapter()])
  const connection = await hub.connect({ ...config, runtimeStateStores: stores })
  await connection.setClock({ currentTime: compiled.world.startsAt, updatedAt: nowIso(), paused: true, speed: 1 })
  expect((await connection.sendCommand(command('world.ambulance.set-road-weather-policy', { enabled: true, iceFactor: .11 }))).ok).toBe(true)
  const point = { type: 'Point', coordinates: [11.41, 59.13] }
  const sample = await connection.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } })
  const snapshot = await connection.getSnapshot()
  await connection.close()
  const restored = await hub.connect({ ...config, initialObjects: snapshot.objects, runtimeStateStores: stores })
  try {
    expect(await restored.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } })).toEqual(sample)
    expect(await restored.invokeQuery({ capabilityId: 'world.ambulance.road-weather-policy', input: {} })).toMatchObject({ enabled: true, iceFactor: .11 })
  } finally { await restored.close() }
})
