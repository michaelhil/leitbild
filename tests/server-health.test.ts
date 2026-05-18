import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { actorIdSchema, commandEnvelopeSchema, nowIso, type CommandEnvelope, type ControlInstanceId, type DomainEvent, type ObjectId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/control-instances/actors.ts'
import { createControlInstanceRealtimeManager, createHealthDetails, type RealtimeEventBatchMessage } from '../src/core/api/server.ts'
import { createControlInstanceRegistry } from '../src/core/control-instances/registry.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createLocalTrafficSimulationAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createTestScenarioCatalog } from './helpers.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'

interface CapturedRealtimeClient {
  readonly events: DomainEvent[]
  readonly eventMessages: RealtimeEventBatchMessage[]
  readonly readyMessages: string[]
}

const operatorActor: Actor = {
  id: actorIdSchema.parse('actor:operator'),
  label: 'Test operator',
  role: 'operator',
}

const waitForMovingObjectEvent = async (
  client: CapturedRealtimeClient,
  objectId: string,
): Promise<void> => {
  await new Promise<void>((resolve, reject): void => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for moving object event: ${objectId}`))
    }, 3_000)

    const poll = (): void => {
      const moving = client.events.some(event =>
        event.type === 'object.upserted'
        && event.object?.id === objectId
        && (event.object.spatial?.position?.speedMps ?? 0) > 0)
      if (!moving) {
        setTimeout(poll, 25)
        return
      }
      clearTimeout(timeout)
      resolve()
    }
    poll()
  })
}

const dispatchAmbulanceCommand = (controlInstanceId: ControlInstanceId, ambulanceId: ObjectId, targetId: ObjectId): CommandEnvelope =>
  commandEnvelopeSchema.parse({
    id: `command:${crypto.randomUUID()}`,
    controlInstanceId,
    actorId: operatorActor.id,
    kind: 'ambulance.set_destination',
    targetObjectIds: [ambulanceId, targetId],
    payload: {
      ambulanceId,
      destinationId: targetId,
    },
    issuedAt: nowIso(),
  }) as CommandEnvelope

describe('server health', () => {
  test('reports process, storage, control instance, and realtime details', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-health-test-'))
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-map-health-test-'))
    const releaseDir = join(mapRoot, 'releases', 'leitbild-osm-norway', 'health-build')
    const glyphDir = join(mapRoot, 'fonts', 'Noto Sans Regular')
    await mkdir(releaseDir, { recursive: true })
    await mkdir(glyphDir, { recursive: true })
    await Bun.write(join(releaseDir, 'norway.pmtiles'), 'pmtiles')
    await Bun.write(join(glyphDir, '0-255.pbf'), 'glyphs')
    await symlink(releaseDir, join(mapRoot, 'current'))
    const registry = createControlInstanceRegistry({
      dataDir,
      scenarioCatalog: createTestScenarioCatalog(),
      simulationAdapters: [
        createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalTrafficSimulationAdapter(),
      ],
    })
    const runtime = await registry.ensure('sandbox' as ControlInstanceId)
    try {
      const details = await createHealthDetails({ registry, mapArtifacts: { rootDir: mapRoot } })

      expect(details.ok).toBe(true)
      expect(details.process.memory.rssBytes).toBeGreaterThan(0)
      expect(details.registry.dataDir).toBe(dataDir)
      expect(details.registry.storage.totalBytes).toBeGreaterThan(0)
      expect(details.registry.controlInstances).toContainEqual({
        id: runtime.id,
        scenarioId: 'oslo-ambulance',
        runId: null,
        loaded: true,
        objectCount: osloAmbulanceScenario.initialObjects.length,
        snapshotSeq: runtime.snapshot().seq,
      })
      expect(details.realtime.websocketClientCount).toBe(0)
      expect(details.realtime.subscribedControlInstanceCount).toBe(0)
      expect(details.mapArtifacts.status).toBe('ready')
      expect(details.mapArtifacts.activeBuildId).toBe('health-build')
      expect(details.mapArtifacts.currentPmtiles.sizeBytes).toBeGreaterThan(0)
      expect(details.mapArtifacts.glyphProbe.available).toBe(true)
    } finally {
      await registry.close(runtime.id)
    }
  })

  test('resubscribes realtime clients after a control instance reset recreates the runtime', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-server-realtime-test-'))
    const controlInstanceId = 'sandbox' as ControlInstanceId
    const registry = createControlInstanceRegistry({
      dataDir,
      scenarioCatalog: createTestScenarioCatalog(),
      simulationAdapters: [
        createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalTrafficSimulationAdapter(),
      ],
    })
    const client: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const realtime = createControlInstanceRealtimeManager<CapturedRealtimeClient>({
      registry,
      send: (targetClient, message) => {
        targetClient.eventMessages.push(message)
        targetClient.events.push(...message.events)
      },
      sendReady: (targetClient, message) => {
        targetClient.readyMessages.push(message.scenarioId ?? '')
      },
    })
    try {
      await registry.ensure(controlInstanceId)
      realtime.addClient(controlInstanceId, client)
      expect(realtime.status().subscribedControlInstanceCount).toBe(1)
      expect(client.readyMessages).toContain('oslo-ambulance')

      await registry.reset(controlInstanceId, { scenarioId: 'halden' })
      realtime.reconcile()
      expect(client.readyMessages).toContain('halden')

      const runtime = registry.get(controlInstanceId)
      if (!runtime) throw new Error('expected control instance runtime after reset')
      const result = await runtime.issueCommand(
        operatorActor,
        dispatchAmbulanceCommand(controlInstanceId, 'amb:halden-1' as ObjectId, 'incident:halden-bridge' as ObjectId),
      )
      expect(result.ok).toBe(true)

      await waitForMovingObjectEvent(client, 'amb:halden-1')
      expect(client.eventMessages.every(message => message.scenarioId === 'halden')).toBe(true)
      realtime.removeClient(controlInstanceId, client)
      expect(realtime.status().subscribedControlInstanceCount).toBe(0)
      expect(registry.get(controlInstanceId)).toBe(runtime)
    } finally {
      realtime.stop()
      await registry.close(controlInstanceId)
    }
  })
})
