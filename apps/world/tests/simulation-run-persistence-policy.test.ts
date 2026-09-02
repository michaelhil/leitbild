import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { ActorId, AdapterId, CommandEnvelope, SimulationRunId, SimulationRunEvent, PackId, ObjectId, OperationalObject } from '../src/core/model/index.ts'
import { commandResultSchema, geoPointFromLonLat, meters, nowIso } from '../src/core/model/index.ts'
import type { PackRuntimeConnection, PackRuntimeEmission, PackRuntimeEventHandler, PackRuntimeEventHistory } from '../src/simulation/protocol.ts'
import { createJsonlEventLog } from '../src/core/simulation-runs/event-log.ts'
import { createSimulationRunSnapshotStore, type SimulationRunSnapshotStore } from '../src/core/simulation-runs/snapshot-store.ts'
import { createSimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { defineSimulationCommandCapability } from '../src/simulation/capabilities.ts'

const simulationRunId = 'run-persistence-policy-test' as SimulationRunId
const objectId = 'object:test-mobile' as ObjectId
const testScenario = { id: 'scenario:test-persistence', startsAt: nowIso() }

const makeObject = (config?: {
  readonly point?: ReturnType<typeof geoPointFromLonLat>
  readonly status?: string
  readonly revision?: number
  readonly packData?: unknown
}): OperationalObject => {
  const at = nowIso()
  return {
    id: objectId,
    kind: 'mobile_entity',
    packId: 'packId:test' as PackId,
    label: 'Test Mobile',
    lifecycle: 'active',
    revision: config?.revision ?? 0,
    spatial: {
      position: {
        point: config?.point ?? geoPointFromLonLat(10.7, 59.9),
        headingDeg: 0,
        speedMps: 0,
        accuracyM: meters(5),
        observedAt: at,
      },
      frame: { kind: 'wgs84' },
    },
    operational: {
      status: config?.status ?? 'available',
      priority: 'normal',
      mode: 'simulated',
    },
    ...(config?.packData === undefined ? {} : { packData: config.packData }),
    alerts: [],
    provenance: {
      source: 'simulator',
      adapterId: 'adapter:test' as AdapterId,
      externalId: objectId,
    },
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
  }
}

const createControlledRuntimeConnection = (
  initialObject: OperationalObject,
  config: {
    readonly commandEventHistory?: (command: CommandEnvelope) => PackRuntimeEventHistory
    readonly sendCommand?: PackRuntimeConnection['sendCommand']
  } = {},
): {
  readonly connection: PackRuntimeConnection
  readonly emit: (events: ReadonlyArray<Parameters<PackRuntimeEventHandler>[0]['events'][number]>) => void
} => {
  const handlers = new Set<PackRuntimeEventHandler>()
  return {
    connection: {
      getSnapshot: async () => ({
        simulationRunId,
        objects: [initialObject],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: PackRuntimeEventHandler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: config.sendCommand ?? (async command => ({
        ok: false,
        commandId: command.id,
        rejectedAt: nowIso(),
        reason: 'test connection does not accept commands',
      })),
      ...(config.commandEventHistory === undefined ? {} : { commandEventHistory: config.commandEventHistory }),
      invokeQuery: async () => { throw new Error('test connection does not accept query Capabilities') },
      observeCommittedEvents: async () => {},
      setClock: async () => {},
      close: async () => {
        handlers.clear()
      },
    },
    emit: (events) => {
      const emission: PackRuntimeEmission = {
        type: 'event.emission',
        events,
        emittedAt: nowIso(),
        runtimeId: 'test-runtime',
      }
      for (const handler of handlers) handler(emission)
    },
  }
}

const operatorActor = {
  id: 'actor:persistence-test-operator' as ActorId,
  label: 'Persistence Test Operator',
  role: 'operator' as const,
}

const readEventLog = async (path: string): Promise<ReadonlyArray<SimulationRunEvent>> => {
  try {
    const raw = await readFile(path, 'utf8')
    return raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as SimulationRunEvent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

const waitFor = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('simulation run persistence policy', () => {
  test('applies volatile object updates to snapshots without retaining them in the durable journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject()
    const runtimeConnection = createControlledRuntimeConnection(initialObject)
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({
        simulationRunId,
        path: join(dataDir, 'snapshot.json'),
      }),
    })

    const movedObject = makeObject({
      point: geoPointFromLonLat(10.71, 59.91),
      revision: 1,
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: movedObject,
      at: nowIso(),
      history: 'snapshot-only',
      provenance: movedObject.provenance,
    }])
    await waitFor(
      async () => runtime.snapshot().objects.find(object => object.id === objectId)?.revision === movedObject.revision,
      'volatile object update',
    )

    expect(runtime.snapshot().objects.find(object => object.id === objectId)?.spatial.position?.point.coordinates)
      .toEqual(movedObject.spatial.position?.point.coordinates)
    expect(runtime.events()).toHaveLength(0)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)

    const assignedObject = makeObject({
      point: geoPointFromLonLat(10.71, 59.91),
      status: 'assigned',
      revision: 2,
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: assignedObject,
      at: nowIso(),
      provenance: assignedObject.provenance,
      history: 'record',
    }])
    await waitFor(
      async () => (await readEventLog(eventLogPath)).length === 1,
      'durable object update',
    )

    expect(runtime.events().map(event => event.type)).toEqual(['object.upserted'])
    expect(await readEventLog(eventLogPath)).toHaveLength(1)
    await runtime.close()
  })

  test('uses explicit runtime history policy instead of interpreting Pack data fields', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject({
      packData: {
        type: 'test-unit',
        schemaVersion: 1,
        plantId: 'system-a',
        projection: {
          summary: 'starting',
          updatedAt: nowIso(),
        },
      },
    })
    const runtimeConnection = createControlledRuntimeConnection(initialObject)
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({
        simulationRunId,
        path: join(dataDir, 'snapshot.json'),
      }),
    })

    const projectionUpdate = makeObject({
      revision: 1,
      packData: {
        type: 'test-unit',
        schemaVersion: 1,
        plantId: 'system-a',
        projection: {
          summary: 'running',
          updatedAt: nowIso(),
        },
      },
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: projectionUpdate,
      at: nowIso(),
      history: 'snapshot-only',
      provenance: projectionUpdate.provenance,
    }])
    await waitFor(
      async () => runtime.snapshot().objects.find(object => object.id === objectId)?.revision === projectionUpdate.revision,
      'projection-only object update',
    )

    expect(runtime.events()).toHaveLength(0)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)

    const packTruthUpdate = makeObject({
      revision: 2,
      packData: {
        type: 'test-unit',
        schemaVersion: 1,
        plantId: 'system-b',
        projection: {
          summary: 'running',
          updatedAt: nowIso(),
        },
      },
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: packTruthUpdate,
      at: nowIso(),
      provenance: packTruthUpdate.provenance,
      history: 'record',
    }])
    await waitFor(
      async () => (await readEventLog(eventLogPath)).length === 1,
      'durable non-projection pack data update',
    )

    expect(runtime.events().map(event => event.type)).toEqual(['object.upserted'])
    expect(await readEventLog(eventLogPath)).toHaveLength(1)
    await runtime.close()
  })

  test('keeps explicitly snapshot-only runtime object upserts out of history even when meaning changes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject({
      packData: {
        type: 'test-system',
        schemaVersion: 1,
        frequencyHz: 50,
      },
    })
    const runtimeConnection = createControlledRuntimeConnection(initialObject)
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({
        simulationRunId,
        path: join(dataDir, 'snapshot.json'),
      }),
    })

    const projectedObject = makeObject({
      status: 'constrained',
      revision: 1,
      packData: {
        type: 'test-system',
        schemaVersion: 1,
        frequencyHz: 49.82,
      },
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: projectedObject,
      at: nowIso(),
      history: 'snapshot-only',
      provenance: projectedObject.provenance,
    }])
    await waitFor(
      async () => runtime.snapshot().objects.find(object => object.id === objectId)?.revision === projectedObject.revision,
      'explicit projected runtime update',
    )

    expect(runtime.snapshot().objects.find(object => object.id === objectId)?.operational.status).toBe('constrained')
    expect(runtime.events()).toHaveLength(0)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)
    await runtime.close()
  })

  test('keeps projected command lifecycle events out of the durable journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject()
    const runtimeConnection = createControlledRuntimeConnection(initialObject, {
      commandEventHistory: command => command.kind === 'world.test.fast-control' ? 'snapshot-only' : 'record',
      sendCommand: async command => ({
        ok: true,
        commandId: command.id,
        acceptedAt: nowIso(),
      }),
    })
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({
        simulationRunId,
        path: join(dataDir, 'snapshot.json'),
      }),
      runtimeCapabilities: [{
        packId: 'packId:test',
        runtimeId: 'runtime:test',
        capability: defineSimulationCommandCapability({
          id: 'world.test.fast-control',
          title: 'Test fast control',
          description: 'Exercises projected command lifecycle persistence.',
          idempotent: false,
          input: z.object({}).strict(),
          output: commandResultSchema,
          buildCommand: input => ({ targetObjectIds: [objectId], payload: input }),
        }),
      }],
    })

    const outcome = await runtime.invokeCapability(operatorActor, {
      capabilityId: 'world.test.fast-control',
      input: {},
    })

    expect(outcome.kind).toBe('command')
    if (outcome.kind !== 'command') throw new Error('expected command Capability result')
    expect(outcome.result.ok).toBe(true)
    expect(runtime.events()).toHaveLength(0)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)
    expect(runtime.metrics().publishedEvents.projectedEvents).toBe(2)
    await runtime.close()
  })

  test('flushes projected snapshots on close instead of writing every runtime projection immediately', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject()
    const runtimeConnection = createControlledRuntimeConnection(initialObject)
    const savedSnapshots: unknown[] = []
    const snapshotStore: SimulationRunSnapshotStore = {
      load: async () => null,
      save: async (snapshot) => {
        savedSnapshots.push(snapshot)
      },
    }
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore,
    })
    expect(savedSnapshots).toHaveLength(1)

    const projectedObject = makeObject({
      revision: 1,
      point: geoPointFromLonLat(10.72, 59.92),
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: projectedObject,
      at: nowIso(),
      history: 'snapshot-only',
      provenance: projectedObject.provenance,
    }])
    await waitFor(
      async () => runtime.snapshot().objects.find(object => object.id === objectId)?.revision === projectedObject.revision,
      'projected snapshot throttle update',
    )

    expect(savedSnapshots).toHaveLength(1)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)

    await runtime.close()
    expect(savedSnapshots).toHaveLength(2)
    const lastSnapshot = savedSnapshots.at(-1) as { readonly objects: ReadonlyArray<OperationalObject> } | undefined
    expect(lastSnapshot?.objects.find(object => object.id === objectId)?.revision).toBe(1)
  })
})
