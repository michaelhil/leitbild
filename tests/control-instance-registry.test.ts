import { describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, DomainEvent } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import type { ControlInstanceRuntime } from '../src/core/control-instances/runtime.ts'
import { createControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import { assignToIncidentCommandKind } from '../src/domains/ambulance/commands.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/domains/ambulance/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

describe('control instance registry', () => {
  const createRegistry = (dataDir: string) => createControlInstanceRegistry({
    dataDir,
    simulationAdapter: createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
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

  test('rejoins an existing control instance by id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createRegistry(dataDir)
    const firstJoin = await registry.ensure('sandbox' as ControlInstanceId)
    const secondJoin = await registry.ensure('sandbox' as ControlInstanceId)

    expect(secondJoin).toBe(firstJoin)
    expect(registry.list()).toHaveLength(1)
    expect(await registry.close('sandbox' as ControlInstanceId)).toBe(true)
  })

  test('lists persisted control instances that are not currently loaded', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const firstRegistry = createRegistry(dataDir)
    await firstRegistry.ensure(controlInstanceId)
    expect(await firstRegistry.close(controlInstanceId)).toBe(true)

    const secondRegistry = createRegistry(dataDir)
    const known = await secondRegistry.listKnown()

    expect(known).toContainEqual({
      id: controlInstanceId,
      loaded: false,
      snapshotSeq: 0,
      objectCount: 3,
    })
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
