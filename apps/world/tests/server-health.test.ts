import { describe, expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { actorIdSchema, commandEnvelopeSchema, nowIso, type CommandEnvelope, type SimulationRunId, type SimulationRunEvent, type ObjectId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createHealthDetails, staticContentTypeForPath } from '../src/core/api/server.ts'
import { createSimulationRunRealtimeManager, type RealtimeEventBatchMessage, type RealtimeOutboundMessage } from '../src/core/api/realtime.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createLocalTrafficPackRuntimeAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createTestScenarioCatalog } from './helpers.ts'
import { osloAmbulanceScenario } from '../src/scenarios/index.ts'

interface CapturedRealtimeClient {
  readonly events: SimulationRunEvent[]
  readonly eventMessages: RealtimeEventBatchMessage[]
  readonly readyMessages: string[]
}

const operatorActor: Actor = {
  id: actorIdSchema.parse('actor:operator'),
  label: 'Test operator',
  role: 'operator',
}

const captureRealtimeMessage = (
  targetClient: CapturedRealtimeClient,
  message: RealtimeOutboundMessage,
): void => {
  if (message.type !== 'events') return
  targetClient.eventMessages.push(message)
  targetClient.events.push(...message.events)
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

const waitForRuntimeClosed = async (
  registry: ReturnType<typeof createSimulationRunRegistry>,
  simulationRunId: SimulationRunId,
): Promise<void> => {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (!registry.get(simulationRunId)) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for idle runtime close: ${simulationRunId}`)
}

const dispatchAmbulanceCommand = (simulationRunId: SimulationRunId, ambulanceId: ObjectId, targetId: ObjectId): CommandEnvelope =>
  commandEnvelopeSchema.parse({
    id: `command:${crypto.randomUUID()}`,
    simulationRunId,
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
  test('serves module worker assets with a JavaScript MIME type', () => {
    expect(staticContentTypeForPath('/assets/maplibre-gl-worker-hash.mjs')).toBe('application/javascript')
    expect(staticContentTypeForPath('/assets/OperationalMap-hash.js')).toBe('application/javascript')
    expect(staticContentTypeForPath('/assets/index-hash.css')).toBe('text/css')
    expect(staticContentTypeForPath('/assets/leitbild-symbols.svg')).toBe('image/svg+xml')
    expect(staticContentTypeForPath('/assets/unknown.bin')).toBe('application/octet-stream')
  })

  test('reports process, storage, simulation run, and realtime details', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-health-test-'))
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-map-health-test-'))
    const releaseDir = join(mapRoot, 'releases', 'leitbild-osm-norway', 'health-build')
    const glyphDir = join(mapRoot, 'fonts', 'Noto Sans Regular')
    await mkdir(releaseDir, { recursive: true })
    await mkdir(glyphDir, { recursive: true })
    await Bun.write(join(releaseDir, 'norway.pmtiles'), 'pmtiles')
    await Bun.write(join(glyphDir, '0-255.pbf'), 'glyphs')
    await symlink(releaseDir, join(mapRoot, 'current'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioCatalog: createTestScenarioCatalog(),
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalTrafficPackRuntimeAdapter(),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const runtime = await registry.create()
    try {
      const details = await createHealthDetails({ registry, mapArtifacts: { rootDir: mapRoot } })

      expect(details.ok).toBe(true)
      expect(details.process.memory.rssBytes).toBeGreaterThan(0)
      expect(details.registry.dataDir).toContain(`/workspaces/${registry.workspaceId}/world`)
      expect(details.registry.storage.totalBytes).toBeGreaterThan(0)
      expect(details.registry.simulationRuns).toContainEqual(expect.objectContaining({
        id: runtime.id,
        scenarioId: 'oslo-ambulance',
        loaded: true,
        objectCount: osloAmbulanceScenario.initialObjects.length,
        snapshotSeq: runtime.snapshot().seq,
      }))
      expect(details.realtime.websocketClientCount).toBe(0)
      expect(details.realtime.subscribedSimulationRunCount).toBe(0)
      expect(details.mapArtifacts.status).toBe('ready')
      expect(details.mapArtifacts.activeBuildId).toBe('health-build')
      expect(details.mapArtifacts.currentPmtiles.sizeBytes).toBeGreaterThan(0)
      expect(details.mapArtifacts.glyphProbe.available).toBe(true)
      expect(details.mapArtifacts.terrain.available).toBe(false)
      expect(details.mapArtifacts.terrain.tileTemplate).toBe('/map/terrain/current/{z}/{x}/{y}.png')
    } finally {
      await registry.close(runtime.id)
    }
  })

  test('resubscribes realtime clients after a simulation run reset recreates the runtime', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-server-realtime-test-'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioCatalog: createTestScenarioCatalog(),
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalTrafficPackRuntimeAdapter(),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const client: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const realtime = createSimulationRunRealtimeManager<CapturedRealtimeClient>({
      registry,
      send: captureRealtimeMessage,
      sendReady: (targetClient, message) => {
        targetClient.readyMessages.push(message.scenarioId ?? '')
      },
    })
    let simulationRunId: SimulationRunId | undefined
    try {
      const runtimeBeforeReset = await registry.create()
      simulationRunId = runtimeBeforeReset.id
      realtime.addClient(simulationRunId, client)
      expect(realtime.status().subscribedSimulationRunCount).toBe(1)
      expect(client.readyMessages).toContain('oslo-ambulance')

      await registry.reset(simulationRunId)
      const resetEvent = client.events.find(event => event.type === 'simulationRun.reset')
      expect(resetEvent).toMatchObject({
        type: 'simulationRun.reset',
        previousScenarioId: 'oslo-ambulance',
        scenarioId: 'oslo-ambulance',
      })
      realtime.reconcile()
      expect(client.readyMessages.filter(id => id === 'oslo-ambulance')).toHaveLength(2)

      const runtime = registry.get(simulationRunId)
      if (!runtime) throw new Error('expected simulation run runtime after reset')
      const result = await runtime.issueCommand(
        operatorActor,
        dispatchAmbulanceCommand(simulationRunId, 'amb:a12' as ObjectId, 'incident:gronland-unattended' as ObjectId),
      )
      expect(result.ok).toBe(true)

      await waitForMovingObjectEvent(client, 'amb:a12')
      const postResetEventMessages = client.eventMessages.filter(message =>
        !message.events.some(event => event.type === 'simulationRun.reset'),
      )
      expect(postResetEventMessages.every(message => message.scenarioId === 'oslo-ambulance')).toBe(true)
      realtime.removeClient(simulationRunId, client)
      expect(realtime.status().subscribedSimulationRunCount).toBe(0)
      expect(registry.get(simulationRunId)).toBe(runtime)
    } finally {
      realtime.stop()
      if (simulationRunId) await registry.close(simulationRunId)
    }
  })

  test('sends realtime ready to every client that joins an already-subscribed simulation run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-server-second-client-test-'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioCatalog: createTestScenarioCatalog(),
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalTrafficPackRuntimeAdapter(),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const firstClient: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const secondClient: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const realtime = createSimulationRunRealtimeManager<CapturedRealtimeClient>({
      registry,
      send: captureRealtimeMessage,
      sendReady: (targetClient, message) => {
        targetClient.readyMessages.push(message.scenarioId ?? '')
      },
    })
    let simulationRunId: SimulationRunId | undefined
    try {
      const runtime = await registry.create()
      simulationRunId = runtime.id
      realtime.addClient(simulationRunId, firstClient)
      expect(firstClient.readyMessages).toEqual(['oslo-ambulance'])
      expect(realtime.status().subscribedSimulationRunCount).toBe(1)

      realtime.addClient(simulationRunId, secondClient)
      expect(secondClient.readyMessages).toEqual(['oslo-ambulance'])
      expect(firstClient.readyMessages).toEqual(['oslo-ambulance'])
      expect(realtime.status().websocketClientCount).toBe(2)
      expect(realtime.status().subscribedSimulationRunCount).toBe(1)

      await registry.reset(simulationRunId)
      realtime.reconcile()
      expect(firstClient.readyMessages).toEqual(['oslo-ambulance', 'oslo-ambulance'])
      expect(secondClient.readyMessages).toEqual(['oslo-ambulance', 'oslo-ambulance'])
    } finally {
      realtime.stop()
      if (simulationRunId) await registry.close(simulationRunId)
    }
  })

  test('does not snapshot the runtime for pure realtime broadcasts', () => {
    const simulationRunId = 'run-runtime-realtime-cache-test' as SimulationRunId
    const handlers = new Set<Parameters<NonNullable<ReturnType<SimulationRunRegistry['get']>>['subscribe']>[0]>()
    let snapshotSeq = 7
    let snapshotCalls = 0
    const runtime = {
      snapshot: () => {
        snapshotCalls += 1
        return {
          objects: [],
          seq: snapshotSeq,
          scenario: { scenarioId: 'scenario:realtime-cache' },
        }
      },
      subscribe: (handler: Parameters<NonNullable<ReturnType<SimulationRunRegistry['get']>>['subscribe']>[0]) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    } as unknown as NonNullable<ReturnType<SimulationRunRegistry['get']>>
    const registry = {
      get: (id: SimulationRunId) => id === simulationRunId ? runtime : null,
      acquireLease: () => () => {},
    } as unknown as SimulationRunRegistry
    const messages: RealtimeOutboundMessage[] = []
    const realtime = createSimulationRunRealtimeManager<{ readonly id: string }>({
      registry,
      send: (_client, message) => {
        messages.push(message)
      },
      sendReady: () => {},
    })

    realtime.addClient(simulationRunId, { id: 'client:1' })
    const setupSnapshotCalls = snapshotCalls
    for (const handler of handlers) {
      handler({
        type: 'event.notification',
        events: [],
        realtimeMessages: [{ type: 'test.motion', at: nowIso(), payload: { x: 1 } }],
      })
    }
    expect(snapshotCalls).toBe(setupSnapshotCalls)
    expect(messages.at(-1)).toMatchObject({
      type: 'runtime.realtime',
      snapshotSeq: 7,
    })

    snapshotSeq = 8
    for (const handler of handlers) {
      handler({
        type: 'event.notification',
        events: [{ type: 'test.event', seq: 8, at: nowIso() } as unknown as SimulationRunEvent],
      })
    }
    expect(snapshotCalls).toBe(setupSnapshotCalls + 1)
    expect(messages.at(-1)).toMatchObject({
      type: 'events',
      snapshotSeq: 8,
    })
    realtime.stop()
  })

  test('closes idle runtimes after the last realtime client leaves', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-server-idle-client-test-'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioCatalog: createTestScenarioCatalog(),
      idleRuntimeCloseDelayMs: 5,
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalTrafficPackRuntimeAdapter(),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const client: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const realtime = createSimulationRunRealtimeManager<CapturedRealtimeClient>({
      registry,
      send: captureRealtimeMessage,
      sendReady: (targetClient, message) => {
        targetClient.readyMessages.push(message.scenarioId ?? '')
      },
    })
    let simulationRunId: SimulationRunId | undefined
    try {
      const runtime = await registry.create()
      simulationRunId = runtime.id
      realtime.addClient(simulationRunId, client)
      expect(registry.get(simulationRunId)).toBe(runtime)

      realtime.removeClient(simulationRunId, client)
      await waitForRuntimeClosed(registry, simulationRunId)
      expect(realtime.status().websocketClientCount).toBe(0)
      expect(realtime.status().subscribedSimulationRunCount).toBe(0)
    } finally {
      realtime.stop()
      if (simulationRunId) await registry.close(simulationRunId)
    }
  })
})
