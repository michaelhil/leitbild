import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AdapterId, ControlInstanceId, DomainEvent, DomainId, ObjectId, OperationalObject } from '../src/core/model/index.ts'
import { geoPointFromLonLat, meters, nowIso } from '../src/core/model/index.ts'
import type { SimulationConnection, SimulationEmission, SimulationEventHandler } from '../src/simulation/protocol.ts'
import { createJsonlEventLog } from '../src/core/control-instances/event-log.ts'
import { createControlInstanceSnapshotStore } from '../src/core/control-instances/snapshot-store.ts'
import { createControlInstanceRuntime } from '../src/core/control-instances/runtime.ts'

const controlInstanceId = 'control-instance:persistence-policy-test' as ControlInstanceId
const objectId = 'object:test-mobile' as ObjectId

const makeObject = (config?: {
  readonly point?: ReturnType<typeof geoPointFromLonLat>
  readonly status?: string
  readonly revision?: number
}): OperationalObject => {
  const at = nowIso()
  return {
    id: objectId,
    kind: 'mobile_entity',
    domain: 'domain:test' as DomainId,
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

const createControlledSimulation = (initialObject: OperationalObject): {
  readonly connection: SimulationConnection
  readonly emit: (events: ReadonlyArray<Parameters<SimulationEventHandler>[0]['events'][number]>) => void
} => {
  const handlers = new Set<SimulationEventHandler>()
  return {
    connection: {
      getSnapshot: async () => ({
        controlInstanceId,
        objects: [initialObject],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: SimulationEventHandler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async command => ({
        ok: false,
        commandId: command.id,
        rejectedAt: nowIso(),
        reason: 'test connection does not accept commands',
      }),
      observeCommittedEvents: async () => {},
      setClock: async () => {},
      close: async () => {
        handlers.clear()
      },
    },
    emit: (events) => {
      const emission: SimulationEmission = {
        type: 'event.emission',
        events,
        emittedAt: nowIso(),
        providerId: 'test-provider',
      }
      for (const handler of handlers) handler(emission)
    },
  }
}

const readEventLog = async (path: string): Promise<ReadonlyArray<DomainEvent>> => {
  try {
    const raw = await readFile(path, 'utf8')
    return raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as DomainEvent)
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

describe('control instance persistence policy', () => {
  test('applies volatile object updates to snapshots without retaining them in the durable journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject()
    const simulation = createControlledSimulation(initialObject)
    const runtime = await createControlInstanceRuntime({
      id: controlInstanceId,
      simulation: simulation.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createControlInstanceSnapshotStore({
        controlInstanceId,
        path: join(dataDir, 'snapshot.json'),
      }),
    })

    const movedObject = makeObject({
      point: geoPointFromLonLat(10.71, 59.91),
      revision: 1,
    })
    simulation.emit([{
      type: 'object.upserted',
      object: movedObject,
      at: nowIso(),
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
    simulation.emit([{
      type: 'object.upserted',
      object: assignedObject,
      at: nowIso(),
      provenance: assignedObject.provenance,
    }])
    await waitFor(
      async () => (await readEventLog(eventLogPath)).length === 1,
      'durable object update',
    )

    expect(runtime.events().map(event => event.type)).toEqual(['object.upserted'])
    expect(await readEventLog(eventLogPath)).toHaveLength(1)
    await runtime.close()
  })
})
