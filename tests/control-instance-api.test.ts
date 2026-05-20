import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ControlInstanceId, OperationalObject, SimulationClockState } from '../src/core/model/index.ts'
import { deleteObjectCommandKind, geoPointFromLonLat } from '../src/core/model/index.ts'
import { handleControlInstanceApi } from '../src/core/api/control-instance-routes.ts'
import { createControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import type { ControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { setDestinationCommandKind } from '../src/packs/ambulance/commands.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { assetArrivedAtTargetSignalType } from '../src/packs/ambulance/sim/interactions.ts'
import { createLocalTrafficSimulationAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { createLocalWeatherSimulationAdapter } from '../src/packs/weather/sim/adapter.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createTestScenarioCatalog } from './helpers.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'

interface ApiResponse<T> {
  readonly status: number
  readonly body: T
}

const createTestRegistry = async (): Promise<ControlInstanceRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-api-test-'))
  return createControlInstanceRegistry({
    dataDir,
    scenarioCatalog: createTestScenarioCatalog(),
    simulationAdapters: [
      createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
      createLocalTrafficSimulationAdapter(),
      createLocalWeatherSimulationAdapter(),
    ],
    interactionHandlers: [ambulancePack, trafficPack, weatherPack].flatMap(pack => pack.interactionHandlers ?? []),
  })
}

const callRoute = async <T>(
  registry: ControlInstanceRegistry,
  path: string,
  init?: RequestInit,
  websocketClients?: ReadonlyArray<{ readonly id: ControlInstanceId; readonly websocketClientCount: number }>,
): Promise<ApiResponse<T>> => {
  const request = new Request(`http://leitbild.test${path}`, init)
  const response = await handleControlInstanceApi(request, new URL(request.url), {
    registry,
    ...(websocketClients === undefined ? {} : { websocketClients }),
  })
  if (!response) throw new Error(`route did not handle ${init?.method ?? 'GET'} ${path}`)
  const body = await response.json() as T
  return { status: response.status, body }
}

describe('control instance API', () => {
  test('lists and fetches scenario definitions', async () => {
    const registry = await createTestRegistry()
    const listed = await callRoute<{ readonly defaultScenarioId: string; readonly scenarios: readonly { readonly id: string; readonly title: string; readonly description?: string; readonly packs?: readonly string[]; readonly requiredProviderIds?: readonly string[] }[] }>(
      registry,
      '/api/scenarios',
    )
    expect(listed.status).toBe(200)
    expect(listed.body.defaultScenarioId).toBe('oslo-ambulance')
    expect(listed.body.scenarios.map(scenario => scenario.id)).toContain('oslo-ambulance')
    expect(listed.body.scenarios.map(scenario => scenario.id)).toContain('halden')
    const oslo = listed.body.scenarios.find(scenario => scenario.id === 'oslo-ambulance')
    expect(oslo?.title).toBe('Oslo ambulance tutorial')
    expect(oslo?.packs).toBeUndefined()
    expect(oslo?.requiredProviderIds).toBeUndefined()

    const fetched = await callRoute<{ readonly scenario: { readonly id: string; readonly packs: readonly string[]; readonly initialObjects: readonly unknown[] } }>(
      registry,
      '/api/scenarios/oslo-ambulance',
    )
    expect(fetched.status).toBe(200)
    expect(fetched.body.scenario.id).toBe('oslo-ambulance')
    expect(fetched.body.scenario.packs).toEqual(['ambulance', 'traffic', 'weather'])
    expect(fetched.body.scenario.initialObjects).toHaveLength(osloAmbulanceScenario.initialObjects.length)
  })

  test('joins a named control instance and exposes objects', async () => {
    const registry = await createTestRegistry()
    try {
      const joined = await callRoute<{ readonly id: ControlInstanceId; readonly snapshot: { readonly objects: readonly { readonly id: string; readonly kind: string }[] } }>(
        registry,
        '/api/control-instances/sandbox',
        { method: 'POST' },
      )
      expect(joined.status).toBe(200)
      expect(joined.body.id).toBe('sandbox' as ControlInstanceId)
      expect(joined.body.snapshot.objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)

      const objects = await callRoute<{ readonly objects: readonly { readonly id: string; readonly kind: string }[] }>(
        registry,
        '/api/control-instances/sandbox/objects',
      )
      expect(objects.status).toBe(200)
      expect(objects.body.objects.map(object => object.kind).sort()).toEqual(
        osloAmbulanceScenario.initialObjects.map(object => object.kind).sort(),
      )
    } finally {
      await registry.close('sandbox' as ControlInstanceId)
    }
  })

  test('routes generic pack queries to active simulation providers', async () => {
    const registry = await createTestRegistry()
    try {
      await callRoute(
        registry,
        '/api/control-instances/query-sandbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'oslo-ambulance' }),
        },
      )

      const weather = await callRoute<{ readonly response: { readonly ok: boolean; readonly result?: { readonly state?: unknown } } }>(
        registry,
        '/api/control-instances/query-sandbox/queries',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packId: 'weather',
            kind: 'weather.sampleAtPoint',
            payload: { point: geoPointFromLonLat(10.7522, 59.9139) },
          }),
        },
      )
      expect(weather.status).toBe(200)
      expect(weather.body.response.ok).toBe(true)
      expect(weather.body.response.result?.state).toBeTruthy()

      const ambulance = await callRoute<{ readonly response: { readonly ok: boolean; readonly result?: { readonly ambulances?: readonly unknown[] } } }>(
        registry,
        '/api/control-instances/query-sandbox/queries',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packId: 'ambulance',
            kind: 'ambulance.dispatchState',
            payload: {},
          }),
        },
      )
      expect(ambulance.status).toBe(200)
      expect(ambulance.body.response.ok).toBe(true)
      expect(ambulance.body.response.result?.ambulances?.length).toBeGreaterThan(0)

      const traffic = await callRoute<{ readonly response: { readonly ok: boolean; readonly result?: { readonly conditions?: readonly unknown[] } } }>(
        registry,
        '/api/control-instances/query-sandbox/queries',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packId: 'traffic',
            kind: 'traffic.conditions',
            payload: {},
          }),
        },
      )
      expect(traffic.status).toBe(200)
      expect(traffic.body.response.ok).toBe(true)
      expect(traffic.body.response.result?.conditions?.length).toBeGreaterThan(0)
    } finally {
      await registry.close('query-sandbox' as ControlInstanceId)
    }
  })

  test('joins a named control instance from an explicit scenario id and rejects unknown scenarios', async () => {
    const registry = await createTestRegistry()
    try {
      const joined = await callRoute<{ readonly id: ControlInstanceId; readonly snapshot: { readonly objects: readonly unknown[] } }>(
        registry,
        '/api/control-instances/scenario-sandbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'oslo-ambulance' }),
        },
      )
      expect(joined.status).toBe(200)
      expect(joined.body.snapshot.objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)

      const rejected = await callRoute<{ readonly error: { readonly code: string } }>(
        registry,
        '/api/control-instances/bad-scenario-sandbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'missing-scenario' }),
        },
      )
      expect(rejected.status).toBe(404)
      expect(rejected.body.error.code).toBe('scenario_not_found')
    } finally {
      await registry.close('scenario-sandbox' as ControlInstanceId)
    }
  })

  test('resets a control instance from a scenario and clears previous object changes', async () => {
    const registry = await createTestRegistry()
    try {
      const joined = await callRoute<{ readonly snapshot: { readonly objects: readonly { readonly id: string; readonly kind: string }[] } }>(
        registry,
        '/api/control-instances/reset-sandbox',
        { method: 'POST' },
      )
      const hospital = joined.body.snapshot.objects.find(object => object.kind === 'facility')
      if (!hospital) throw new Error('missing reset test hospital')

      const deleted = await callRoute<{ readonly result: { readonly ok: boolean } }>(
        registry,
        '/api/control-instances/reset-sandbox/commands',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: deleteObjectCommandKind,
            targetObjectIds: [hospital.id],
            payload: { objectId: hospital.id },
          }),
        },
      )
      expect(deleted.body.result.ok).toBe(true)

      const reset = await callRoute<{ readonly snapshot: { readonly objects: readonly unknown[]; readonly seq: number } }>(
        registry,
        '/api/control-instances/reset-sandbox/reset',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'oslo-ambulance' }),
        },
      )
      expect(reset.status).toBe(200)
      expect(reset.body.snapshot.seq).toBeGreaterThanOrEqual(0)
      expect(reset.body.snapshot.objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)
    } finally {
      await registry.close('reset-sandbox' as ControlInstanceId)
    }
  })

  test('rejects reset with an unknown scenario id', async () => {
    const registry = await createTestRegistry()
    const rejected = await callRoute<{ readonly error: { readonly code: string } }>(
      registry,
      '/api/control-instances/reset-unknown-scenario/reset',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'missing-scenario' }),
      },
    )
    expect(rejected.status).toBe(404)
    expect(rejected.body.error.code).toBe('scenario_not_found')
  })

  test('creates and lists known control instances', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await callRoute<{ readonly id: ControlInstanceId; readonly snapshot: { readonly objects: readonly unknown[]; readonly seq: number } }>(
        registry,
        '/api/control-instances',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'api-created' }),
        },
      )
      expect(created.status).toBe(201)
      expect(created.body.id).toBe('api-created' as ControlInstanceId)
      expect(created.body.snapshot.objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)

      const listed = await callRoute<{ readonly controlInstances: readonly { readonly id: string; readonly scenarioId: string | null; readonly runId: string | null; readonly loaded: boolean; readonly objectCount: number | null; readonly snapshotSeq: number | null; readonly websocketClientCount: number }[] }>(
        registry,
        '/api/control-instances',
      )
      expect(listed.body.controlInstances).toContainEqual({
        id: 'api-created',
        scenarioId: 'oslo-ambulance',
        runId: null,
        loaded: true,
        objectCount: osloAmbulanceScenario.initialObjects.length,
        snapshotSeq: created.body.snapshot.seq,
        websocketClientCount: 0,
      })
    } finally {
      await registry.close('api-created' as ControlInstanceId)
    }
  })

  test('lists scenario-first run metadata for routable control instances', async () => {
    const registry = await createTestRegistry()
    try {
      await callRoute(
        registry,
        '/api/control-instances/halden%3Asandbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'halden' }),
        },
      )

      const listed = await callRoute<{ readonly controlInstances: readonly { readonly id: string; readonly scenarioId: string | null; readonly runId: string | null; readonly websocketClientCount: number }[] }>(
        registry,
        '/api/control-instances',
      )

      expect(listed.body.controlInstances).toContainEqual(expect.objectContaining({
        id: 'halden:sandbox',
        scenarioId: 'halden',
        runId: 'sandbox',
        websocketClientCount: 0,
      }))
    } finally {
      await registry.close('halden:sandbox' as ControlInstanceId)
    }
  })

  test('deletes runs only when no websocket users are connected', async () => {
    const registry = await createTestRegistry()
    const controlInstanceId = 'halden:sandbox' as ControlInstanceId
    try {
      await callRoute(
        registry,
        '/api/control-instances/halden%3Asandbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: 'halden' }),
        },
      )

      const blocked = await callRoute<{ readonly error: { readonly code: string } }>(
        registry,
        '/api/control-instances/halden%3Asandbox',
        { method: 'DELETE' },
        [{ id: controlInstanceId, websocketClientCount: 1 }],
      )
      expect(blocked.status).toBe(409)
      expect(blocked.body.error.code).toBe('control_instance_has_users')
      expect(registry.get(controlInstanceId)).toBeDefined()

      const deleted = await callRoute<{ readonly id: ControlInstanceId; readonly deleted: true }>(
        registry,
        '/api/control-instances/halden%3Asandbox',
        { method: 'DELETE' },
      )
      expect(deleted.status).toBe(200)
      expect(deleted.body).toEqual({ id: controlInstanceId, deleted: true })
      expect(registry.get(controlInstanceId)).toBeUndefined()
      expect(await registry.listKnown()).not.toContainEqual(expect.objectContaining({ id: controlInstanceId }))
    } finally {
      await registry.close(controlInstanceId)
    }
  })

  test('creates control instances from explicit scenario ids and rejects unknown scenarios', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await callRoute<{ readonly id: ControlInstanceId; readonly snapshot: { readonly objects: readonly unknown[] } }>(
        registry,
        '/api/control-instances',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'api-scenario-created', scenarioId: 'oslo-ambulance' }),
        },
      )
      expect(created.status).toBe(201)
      expect(created.body.snapshot.objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)

      const rejected = await callRoute<{ readonly error: { readonly code: string } }>(
        registry,
        '/api/control-instances',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'api-unknown-scenario', scenarioId: 'missing-scenario' }),
        },
      )
      expect(rejected.status).toBe(404)
      expect(rejected.body.error.code).toBe('scenario_not_found')
    } finally {
      await registry.close('api-scenario-created' as ControlInstanceId)
    }
  })

  test('records command events with actor and client attribution', async () => {
    const registry = await createTestRegistry()
    try {
      const joined = await callRoute<{ readonly snapshot: { readonly objects: readonly { readonly id: string; readonly kind: string }[] } }>(
        registry,
        '/api/control-instances/sandbox',
        { method: 'POST' },
      )
      const ambulance = joined.body.snapshot.objects.find(object => object.kind === 'mobile_entity')
      const incident = joined.body.snapshot.objects.find(object => object.kind === 'incident')
      if (!ambulance || !incident) throw new Error('missing API test objects')

      const command = await callRoute<{ readonly result: { readonly ok: boolean } }>(
        registry,
        '/api/control-instances/sandbox/commands',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: 'actor:test-api-operator',
            clientId: 'client:test-map',
            kind: setDestinationCommandKind,
            targetObjectIds: [ambulance.id, incident.id],
            payload: {
              ambulanceId: ambulance.id,
              destinationId: incident.id,
            },
          }),
        },
      )
      expect(command.status).toBe(200)
      expect(command.body.result.ok).toBe(true)

      const events = await callRoute<{ readonly events: readonly { readonly seq: number; readonly type: string; readonly command?: { readonly actorId: string; readonly clientId?: string } }[] }>(
        registry,
        '/api/control-instances/sandbox/events',
      )
      const issued = events.body.events.find(event => event.type === 'command.issued')
      expect(issued?.command?.actorId).toBe('actor:test-api-operator')
      expect(issued?.command?.clientId).toBe('client:test-map')
      if (!issued) throw new Error('missing command issued event')

      const afterIssued = await callRoute<{ readonly events: readonly { readonly type: string; readonly command?: { readonly clientId?: string } }[] }>(
        registry,
        `/api/control-instances/sandbox/events?afterSeq=${issued.seq}`,
      )
      expect(afterIssued.body.events.every(event => event.type !== 'command.issued')).toBe(true)
      const snapshot = await callRoute<{ readonly snapshot: { readonly objects: readonly OperationalObject[] } }>(
        registry,
        '/api/control-instances/sandbox/snapshot',
      )
      const updatedAmbulance = snapshot.body.snapshot.objects.find(object => object.id === ambulance.id)
      expect(updatedAmbulance?.spatial.route?.planned).toBeDefined()
    } finally {
      await registry.close('sandbox' as ControlInstanceId)
    }
  })

  test('updates the control instance clock and pauses provider motion', async () => {
    const registry = await createTestRegistry()
    try {
      const joined = await callRoute<{ readonly snapshot: { readonly clock?: SimulationClockState; readonly objects: readonly OperationalObject[] } }>(
        registry,
        '/api/control-instances/clock-sandbox',
        { method: 'POST' },
      )
      expect(joined.body.snapshot.clock?.paused).toBe(false)
      const ambulance = joined.body.snapshot.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
      const incident = joined.body.snapshot.objects.find(object => object.kind === 'incident')
      if (!ambulance || !incident) throw new Error('missing clock API test objects')

      await callRoute(registry, '/api/control-instances/clock-sandbox/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: setDestinationCommandKind,
          targetObjectIds: [ambulance.id, incident.id],
          payload: {
            ambulanceId: ambulance.id,
            destinationId: incident.id,
          },
        }),
      })

      const paused = await callRoute<{ readonly clock: SimulationClockState }>(
        registry,
        '/api/control-instances/clock-sandbox/clock',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: true }),
        },
      )
      expect(paused.body.clock.paused).toBe(true)

      const pauseStart = await callRoute<{ readonly snapshot: { readonly objects: readonly OperationalObject[] } }>(
        registry,
        '/api/control-instances/clock-sandbox/snapshot',
      )
      const pausedStartPoint = pauseStart.body.snapshot.objects.find(object => object.id === ambulance.id)?.spatial.position?.point.coordinates.join(',')
      await Bun.sleep(1_100)
      const pauseEnd = await callRoute<{ readonly snapshot: { readonly objects: readonly OperationalObject[] } }>(
        registry,
        '/api/control-instances/clock-sandbox/snapshot',
      )
      expect(pauseEnd.body.snapshot.objects.find(object => object.id === ambulance.id)?.spatial.position?.point.coordinates.join(',')).toBe(pausedStartPoint)

      const resumed = await callRoute<{ readonly clock: SimulationClockState }>(
        registry,
        '/api/control-instances/clock-sandbox/clock',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: false }),
        },
      )
      expect(resumed.body.clock.paused).toBe(false)
      await Bun.sleep(1_100)
      const moved = await callRoute<{ readonly snapshot: { readonly objects: readonly OperationalObject[] } }>(
        registry,
        '/api/control-instances/clock-sandbox/snapshot',
      )
      expect(moved.body.snapshot.objects.find(object => object.id === ambulance.id)?.spatial.position?.point.coordinates.join(',')).not.toBe(pausedStartPoint)
    } finally {
      await registry.close('clock-sandbox' as ControlInstanceId)
    }
  })

  test('scopes event reads by control instance', async () => {
    const registry = await createTestRegistry()
    try {
      await callRoute(registry, '/api/control-instances/alpha', { method: 'POST' })
      await callRoute(registry, '/api/control-instances/beta', { method: 'POST' })

      const alphaEvents = await callRoute<{ readonly events: readonly { readonly controlInstanceId: string }[] }>(
        registry,
        '/api/control-instances/alpha/events',
      )
      const betaEvents = await callRoute<{ readonly events: readonly { readonly controlInstanceId: string }[] }>(
        registry,
        '/api/control-instances/beta/events',
      )

      expect(alphaEvents.body.events.every(event => event.controlInstanceId === 'alpha')).toBe(true)
      expect(betaEvents.body.events.every(event => event.controlInstanceId === 'beta')).toBe(true)
    } finally {
      await registry.close('alpha' as ControlInstanceId)
      await registry.close('beta' as ControlInstanceId)
    }
  })

  test('deletes objects through the core command path and clears dangling targets', async () => {
    const registry = await createTestRegistry()
    try {
      const joined = await callRoute<{ readonly snapshot: { readonly objects: readonly OperationalObject[] } }>(
        registry,
        '/api/control-instances/sandbox',
        { method: 'POST' },
      )
      const ambulance = joined.body.snapshot.objects.find(object => object.kind === 'mobile_entity')
      const incident = joined.body.snapshot.objects.find(object => object.kind === 'incident')
      if (!ambulance || !incident) throw new Error('missing API test objects')

      await callRoute(registry, '/api/control-instances/sandbox/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actorId: 'actor:test-api-operator',
          kind: setDestinationCommandKind,
          targetObjectIds: [ambulance.id, incident.id],
          payload: {
            ambulanceId: ambulance.id,
            destinationId: incident.id,
          },
        }),
      })

      const deleted = await callRoute<{ readonly result: { readonly ok: boolean; readonly reason?: string } }>(
        registry,
        '/api/control-instances/sandbox/commands',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: 'actor:test-api-operator',
            kind: deleteObjectCommandKind,
            targetObjectIds: [incident.id],
            payload: { objectId: incident.id },
          }),
        },
      )
      expect(deleted.body.result.ok).toBe(true)

      const snapshot = await callRoute<{ readonly snapshot: { readonly objects: readonly OperationalObject[] } }>(
        registry,
        '/api/control-instances/sandbox/snapshot',
      )
      expect(snapshot.body.snapshot.objects.some(object => object.id === incident.id)).toBe(false)
      const cleanedAmbulance = snapshot.body.snapshot.objects.find(object => object.id === ambulance.id)
      expect(cleanedAmbulance?.tasking?.currentTaskId).toBeUndefined()
      expect(cleanedAmbulance?.spatial.route).toBeUndefined()
      expect(cleanedAmbulance?.operational.intent).toBeUndefined()
    } finally {
      await registry.close('sandbox' as ControlInstanceId)
    }
  })

  test('accepts interaction signals through the API and commits notification effects', async () => {
    const registry = await createTestRegistry()
    try {
      const joined = await callRoute<{ readonly snapshot: { readonly objects: readonly { readonly id: string; readonly kind: string; readonly domainData?: unknown }[] } }>(
        registry,
        '/api/control-instances/sandbox',
        { method: 'POST' },
      )
      const ambulance = joined.body.snapshot.objects.find(object => object.kind === 'mobile_entity')
      const incident = joined.body.snapshot.objects.find(object => object.kind === 'incident')
      if (!ambulance || !incident) throw new Error('missing API test objects')

      const signal = await callRoute<{ readonly signal: { readonly type: string } }>(
        registry,
        '/api/control-instances/sandbox/signals',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actorId: 'actor:test-api-operator',
            source: { kind: 'object', id: ambulance.id },
            type: assetArrivedAtTargetSignalType,
            targetObjectIds: [incident.id],
            payload: { targetObjectId: incident.id },
          }),
        },
      )
      expect(signal.status).toBe(202)
      expect(signal.body.signal.type).toBe(assetArrivedAtTargetSignalType)

      const events = await callRoute<{ readonly events: readonly { readonly type: string }[] }>(
        registry,
        '/api/control-instances/sandbox/events',
      )
      expect(events.body.events.some(event => event.type === 'interaction.signal.received')).toBe(true)
      expect(events.body.events.some(event => event.type === 'notification.emitted')).toBe(true)

      const objects = await callRoute<{ readonly objects: readonly { readonly id: string; readonly domainData?: unknown }[] }>(
        registry,
        '/api/control-instances/sandbox/objects',
      )
      expect(objects.body.objects.map(object => object.id).sort()).toEqual(joined.body.snapshot.objects.map(object => object.id).sort())
    } finally {
      await registry.close('sandbox' as ControlInstanceId)
    }
  })

  test('returns 404 for a missing control instance object list', async () => {
    const registry = await createTestRegistry()
    const response = await callRoute<{ readonly error: { readonly code: string; readonly message: string } }>(
      registry,
      '/api/control-instances/missing/objects',
    )
    expect(response.status).toBe(404)
    expect(response.body.error).toEqual({
      code: 'control_instance_not_found',
      message: 'control instance not found',
    })
  })

  test('returns structured errors for invalid control instance ids', async () => {
    const registry = await createTestRegistry()
    const response = await callRoute<{ readonly error: { readonly code: string } }>(
      registry,
      '/api/control-instances/not allowed',
      { method: 'POST' },
    )
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('invalid_request')
  })
})
