import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ControlInstanceId, OperationalObject } from '../src/core/model/index.ts'
import { deleteObjectCommandKind } from '../src/core/model/index.ts'
import { handleControlInstanceApi } from '../src/core/api/control-instance-routes.ts'
import { createControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import type { ControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/domains/ambulance/sim/adapter.ts'
import { setDestinationCommandKind } from '../src/domains/ambulance/commands.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { ambulancePack } from '../src/domains/ambulance/pack.ts'
import { assetArrivedAtTargetSignalType } from '../src/domains/ambulance/sim/interactions.ts'
import { createLocalTrafficSimulationAdapter } from '../src/domains/traffic/sim/adapter.ts'
import { trafficPack } from '../src/domains/traffic/pack.ts'

interface ApiResponse<T> {
  readonly status: number
  readonly body: T
}

const createTestRegistry = async (): Promise<ControlInstanceRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-api-test-'))
  return createControlInstanceRegistry({
    dataDir,
    simulationAdapters: [
      createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
      createLocalTrafficSimulationAdapter(),
    ],
    interactionHandlers: [ambulancePack, trafficPack].flatMap(pack => pack.interactionHandlers ?? []),
  })
}

const callRoute = async <T>(
  registry: ControlInstanceRegistry,
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> => {
  const request = new Request(`http://leitbild.test${path}`, init)
  const response = await handleControlInstanceApi(request, new URL(request.url), { registry })
  if (!response) throw new Error(`route did not handle ${init?.method ?? 'GET'} ${path}`)
  const body = await response.json() as T
  return { status: response.status, body }
}

describe('control instance API', () => {
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
      expect(joined.body.snapshot.objects).toHaveLength(3)

      const objects = await callRoute<{ readonly objects: readonly { readonly id: string; readonly kind: string }[] }>(
        registry,
        '/api/control-instances/sandbox/objects',
      )
      expect(objects.status).toBe(200)
      expect(objects.body.objects.map(object => object.kind).sort()).toEqual(['facility', 'incident', 'mobile_entity'])
    } finally {
      await registry.close('sandbox' as ControlInstanceId)
    }
  })

  test('creates and lists known control instances', async () => {
    const registry = await createTestRegistry()
    try {
      const created = await callRoute<{ readonly id: ControlInstanceId; readonly snapshot: { readonly objects: readonly unknown[] } }>(
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
      expect(created.body.snapshot.objects).toHaveLength(3)

      const listed = await callRoute<{ readonly controlInstances: readonly { readonly id: string; readonly loaded: boolean; readonly objectCount: number | null; readonly snapshotSeq: number | null }[] }>(
        registry,
        '/api/control-instances',
      )
      expect(listed.body.controlInstances).toContainEqual({
        id: 'api-created',
        loaded: true,
        objectCount: 3,
        snapshotSeq: 0,
      })
    } finally {
      await registry.close('api-created' as ControlInstanceId)
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
      expect(cleanedAmbulance?.operational.status).toBe('available')
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
