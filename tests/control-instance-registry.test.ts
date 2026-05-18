import { describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, DomainEvent, InteractionSignal, ObjectId, SignalId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import type { ControlInstanceRuntime } from '../src/core/control-instances/runtime.ts'
import { createControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import { assignToIncidentCommandKind } from '../src/packs/ambulance/commands.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createLocalTrafficSimulationAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { createTestScenarioCatalog } from './helpers.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'

describe('control instance registry', () => {
  const createRegistry = (dataDir: string) => createControlInstanceRegistry({
    dataDir,
    scenarioCatalog: createTestScenarioCatalog(),
    simulationAdapters: [
      createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
      createLocalTrafficSimulationAdapter(),
    ],
  })

  const issueDispatchCommand = async (runtime: ControlInstanceRuntime): Promise<void> => {
    const snapshot = runtime.snapshot()
    const ambulance = snapshot.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = snapshot.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')
    const command: CommandEnvelope = {
      id: `command:test-${crypto.randomUUID()}` as CommandId,
      controlInstanceId: runtime.id,
      actorId: 'actor:test-operator' as ActorId,
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        incidentId: incident.id,
      },
      issuedAt: nowIso(),
    }
    const result = await runtime.issueCommand({ id: command.actorId, label: 'Test Operator', role: 'operator' }, command)
    expect(result.ok).toBe(true)
  }

  const issueDispatchToIncident = async (
    runtime: ControlInstanceRuntime,
    ambulanceId: string,
    incidentId: string,
  ): Promise<void> => {
    const command: CommandEnvelope = {
      id: `command:test-${crypto.randomUUID()}` as CommandId,
      controlInstanceId: runtime.id,
      actorId: 'actor:test-operator' as ActorId,
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulanceId as ObjectId, incidentId as ObjectId],
      payload: {
        ambulanceId,
        incidentId,
      },
      issuedAt: nowIso(),
    }
    const result = await runtime.issueCommand({ id: command.actorId, label: 'Test Operator', role: 'operator' }, command)
    expect(result.ok).toBe(true)
  }

  test('keeps object state scoped to the created control instance', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createRegistry(dataDir)
    const runtime = await registry.create()
    const snapshot = runtime.snapshot()
    const ambulance = snapshot.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = snapshot.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const command: CommandEnvelope = {
      id: 'command:test-control-instance-dispatch' as CommandId,
      controlInstanceId: runtime.id,
      actorId: 'actor:test-operator' as ActorId,
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        incidentId: incident.id,
      },
      issuedAt: nowIso(),
      expectedRevision: ambulance.revision,
    }

    const result = await runtime.issueCommand({
      id: command.actorId,
      label: 'Test Operator',
      role: 'operator',
    }, command)
    expect(result.ok).toBe(true)
    expect(runtime.snapshot().objects.find(object => object.id === ambulance.id)?.operational.status).toBe('assigned')
    await runtime.close()
  })

  test('notifies subscribers with event arrays while preserving canonical event order', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createRegistry(dataDir)
    const runtime = await registry.create()
    const notifications: DomainEvent[][] = []
    const unsubscribe = runtime.subscribe(notification => {
      notifications.push([...notification.events])
    })

    await issueDispatchCommand(runtime)
    unsubscribe()

    const flattened = notifications.flat()
    expect(notifications.every(notification => notification.length > 0)).toBe(true)
    expect(flattened.map(event => event.seq)).toEqual([...flattened.map(event => event.seq)].sort((a, b) => a - b))
    expect(flattened.some(event => event.type === 'object.upserted')).toBe(true)
    expect(flattened.some(event => event.type === 'command.result')).toBe(true)
    await runtime.close()
  })

  test('rejects interaction signals for another control instance', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createRegistry(dataDir)
    const runtime = await registry.ensure('sandbox' as ControlInstanceId)
    const beforeCount = runtime.events().length
    const signal: InteractionSignal = {
      id: `signal:${crypto.randomUUID()}` as SignalId,
      controlInstanceId: 'other-control-instance' as ControlInstanceId,
      at: nowIso(),
      source: { kind: 'actor', id: 'actor:test-operator' as ActorId },
      targets: [{ kind: 'broadcast' }],
      type: 'test.signal',
      payload: {},
    }

    await expect(runtime.publishInteractionSignal(signal, { source: 'operator' })).rejects.toThrow('interaction signal control instance mismatch')
    expect(runtime.events()).toHaveLength(beforeCount)
    await runtime.close()
  })

  test('rejoins an existing control instance by id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createRegistry(dataDir)
    const firstJoin = await registry.ensure('sandbox' as ControlInstanceId)
    const secondJoin = await registry.ensure('sandbox' as ControlInstanceId)

    expect(secondJoin).toBe(firstJoin)
    expect(registry.list()).toHaveLength(1)
    expect(await registry.close('sandbox' as ControlInstanceId)).toBe(true)
  })

  test('resets a loaded control instance when a different scenario is explicitly requested', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createRegistry(dataDir)
    const firstJoin = await registry.ensure('sandbox' as ControlInstanceId, { scenarioId: 'oslo-ambulance' })
    expect(firstJoin.snapshot().scenario?.scenarioId).toBe('oslo-ambulance')

    const switched = await registry.ensure('sandbox' as ControlInstanceId, { scenarioId: 'halden' })

    expect(switched).not.toBe(firstJoin)
    expect(switched.snapshot().scenario?.scenarioId).toBe('halden')
    expect(switched.snapshot().objects.map(object => object.id)).toContain('facility:halden-hospital' as ObjectId)
    expect(switched.snapshot().objects.map(object => object.id)).not.toContain('facility:ous' as ObjectId)
    expect(registry.list()).toHaveLength(1)
    expect(await registry.close('sandbox' as ControlInstanceId)).toBe(true)
  })

  test('resets a persisted control instance when a different scenario is explicitly requested', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const firstRuntime = await firstRegistry.ensure(controlInstanceId, { scenarioId: 'oslo-ambulance' })
    expect(firstRuntime.snapshot().scenario?.scenarioId).toBe('oslo-ambulance')
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)

    const secondRegistry = createRegistry(dataDir)
    const switched = await secondRegistry.ensure(controlInstanceId, { scenarioId: 'halden' })

    expect(switched.snapshot().scenario?.scenarioId).toBe('halden')
    expect(switched.snapshot().objects.map(object => object.id)).toContain('facility:halden-hospital' as ObjectId)
    expect(switched.snapshot().objects.map(object => object.id)).not.toContain('facility:ous' as ObjectId)
    expect(await secondRegistry.close(controlInstanceId)).toBe(true)
  })

  test('keeps multiple Halden ambulances moving after an explicit scenario switch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createRegistry(dataDir)
    await registry.ensure('sandbox' as ControlInstanceId, { scenarioId: 'oslo-ambulance' })
    const runtime = await registry.ensure('sandbox' as ControlInstanceId, { scenarioId: 'halden' })

    await issueDispatchToIncident(runtime, 'amb:halden-1', 'incident:halden-bridge')
    await issueDispatchToIncident(runtime, 'amb:halden-2', 'incident:halden-harbor')

    const assigned = runtime.snapshot().objects
    const firstAssigned = assigned.find(object => object.id === 'amb:halden-1')
    const secondAssigned = assigned.find(object => object.id === 'amb:halden-2')
    const firstStart = firstAssigned?.spatial.position?.point.coordinates.join(',')
    const secondStart = secondAssigned?.spatial.position?.point.coordinates.join(',')
    expect(firstAssigned?.spatial.route?.planned?.coordinates.length).toBeGreaterThanOrEqual(2)
    expect(secondAssigned?.spatial.route?.planned?.coordinates.length).toBeGreaterThanOrEqual(2)

    await Bun.sleep(1_100)

    const moved = runtime.snapshot().objects
    const firstMoved = moved.find(object => object.id === 'amb:halden-1')
    const secondMoved = moved.find(object => object.id === 'amb:halden-2')
    expect(firstMoved?.spatial.position?.point.coordinates.join(',')).not.toBe(firstStart)
    expect(secondMoved?.spatial.position?.point.coordinates.join(',')).not.toBe(secondStart)
    expect(firstMoved?.spatial.position?.speedMps).toBeGreaterThan(0)
    expect(secondMoved?.spatial.position?.speedMps).toBeGreaterThan(0)
    expect(await registry.close('sandbox' as ControlInstanceId)).toBe(true)
  })

  test('lists persisted control instances that are not currently loaded', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const firstRuntime = await firstRegistry.ensure(controlInstanceId)
    const snapshotSeq = firstRuntime.snapshot().seq
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)

    const secondRegistry = createRegistry(dataDir)
    const known = await secondRegistry.listKnown()

    expect(known).toContainEqual({
      id: controlInstanceId,
      loaded: false,
      snapshotSeq,
      objectCount: osloAmbulanceScenario.initialObjects.length,
    })
  })

  test('restores provider snapshots by domain without duplicating objects across providers', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const firstRuntime = await firstRegistry.ensure(controlInstanceId)
    expect(firstRuntime.snapshot().objects).toHaveLength(osloAmbulanceScenario.initialObjects.length)
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)

    const secondRegistry = createRegistry(dataDir)
    const restoredRuntime = await secondRegistry.ensure(controlInstanceId)
    const restoredObjects = restoredRuntime.snapshot().objects

    expect(restoredObjects).toHaveLength(osloAmbulanceScenario.initialObjects.length)
    expect(await secondRegistry.close(controlInstanceId)).toBe(true)
  })

  test('restores a control instance snapshot from disk', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const firstRuntime = await firstRegistry.ensure(controlInstanceId)
    const initial = firstRuntime.snapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const command: CommandEnvelope = {
      id: 'command:test-persisted-dispatch' as CommandId,
      controlInstanceId,
      actorId: 'actor:test-operator' as ActorId,
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        incidentId: incident.id,
      },
      issuedAt: nowIso(),
    }
    const result = await firstRuntime.issueCommand({
      id: command.actorId,
      label: 'Test Operator',
      role: 'operator',
    }, command)
    expect(result.ok).toBe(true)
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)

    const secondRegistry = createRegistry(dataDir)
    const restoredRuntime = await secondRegistry.ensure(controlInstanceId)
    const restoredAmbulance = restoredRuntime.snapshot().objects.find(object => object.id === ambulance.id)

    expect(restoredAmbulance?.tasking?.currentTaskId).toBe(incident.id)
    expect(restoredAmbulance?.spatial.route?.planned).toBeDefined()
    expect(restoredAmbulance?.operational.status).toBe('assigned')
    expect(await secondRegistry.close(controlInstanceId)).toBe(true)
  })

  test('restores event history from disk', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const firstRuntime = await firstRegistry.ensure(controlInstanceId)
    await issueDispatchCommand(firstRuntime)
    const issuedBeforeClose = firstRuntime.events().find(event => event.type === 'command.issued')
    if (!issuedBeforeClose) throw new Error('missing command issued event before close')
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)

    const secondRegistry = createRegistry(dataDir)
    const restoredRuntime = await secondRegistry.ensure(controlInstanceId)
    const restoredIssued = restoredRuntime.events().find(event => event.type === 'command.issued')
    const afterIssued = restoredRuntime.events({ afterSeq: issuedBeforeClose.seq })

    expect(restoredIssued?.id).toBe(issuedBeforeClose.id)
    expect(afterIssued.every(event => event.seq > issuedBeforeClose.seq)).toBe(true)
    expect(await secondRegistry.close(controlInstanceId)).toBe(true)
  })

  test('fails loudly when an event log contains invalid JSON', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    await firstRegistry.ensure(controlInstanceId)
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)
    await appendFile(join(dataDir, 'control-instances', controlInstanceId, 'events.jsonl'), '{not json}\n', 'utf8')

    const secondRegistry = createRegistry(dataDir)
    await expect(secondRegistry.ensure(controlInstanceId)).rejects.toThrow('invalid event log JSON')
  })

  test('fails loudly when an event log contains the wrong control instance id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const runtime = await firstRegistry.ensure(controlInstanceId)
    await issueDispatchCommand(runtime)
    const events = runtime.events()
    if (events.length === 0) throw new Error('missing initial event')
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)
    const eventPath = join(dataDir, 'control-instances', controlInstanceId, 'events.jsonl')
    const wrongEvent: DomainEvent = { ...events[0]!, controlInstanceId: 'other' as ControlInstanceId }
    await writeFile(eventPath, `${JSON.stringify(wrongEvent)}\n`, 'utf8')

    const secondRegistry = createRegistry(dataDir)
    await expect(secondRegistry.ensure(controlInstanceId)).rejects.toThrow('event log control instance mismatch')
  })

  test('fails loudly when an event log sequence regresses', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const runtime = await firstRegistry.ensure(controlInstanceId)
    await issueDispatchCommand(runtime)
    const events = runtime.events()
    if (events.length < 2) throw new Error('missing initial events')
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)
    const eventPath = join(dataDir, 'control-instances', controlInstanceId, 'events.jsonl')
    const regressedEvents = [
      events[0]!,
      { ...events[1]!, seq: events[0]!.seq },
    ]
    await writeFile(eventPath, regressedEvents.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')

    const secondRegistry = createRegistry(dataDir)
    await expect(secondRegistry.ensure(controlInstanceId)).rejects.toThrow('event log sequence regression')
  })

  test('fails loudly when the snapshot is behind the event log', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    const runtime = await firstRegistry.ensure(controlInstanceId)
    await issueDispatchCommand(runtime)
    expect(runtime.events()).not.toHaveLength(0)
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)
    const snapshotPath = join(dataDir, 'control-instances', controlInstanceId, 'snapshot.json')
    const raw = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      readonly schemaVersion: 1
      readonly controlInstanceId: ControlInstanceId
      readonly savedAt: string
      readonly snapshot: {
        readonly objects: unknown[]
        readonly seq: number
      }
    }
    await writeFile(snapshotPath, `${JSON.stringify({
      ...raw,
      snapshot: {
        ...raw.snapshot,
        seq: 0,
      },
    })}\n`, 'utf8')

    const secondRegistry = createRegistry(dataDir)
    await expect(secondRegistry.ensure(controlInstanceId)).rejects.toThrow('snapshot sequence 0 is behind event log sequence')
  })
})
