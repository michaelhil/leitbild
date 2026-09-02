import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type {
  ActorId,
  CommandEnvelope,
  CommandId,
  SimulationRunId,
  IsoTimestamp,
  SimulationClockState,
  ObjectId,
  PackId,
} from '../src/core/model/index.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEmission,
} from '../src/simulation/protocol.ts'
import { definePackCommandCapability, definePackQueryCapability } from '../src/simulation/capabilities.ts'

interface StubAdapter extends PackRuntimeAdapter {
  readonly connectCount: () => number
  readonly closeCount: () => number
  readonly emit: (emission: PackRuntimeEmission) => void
}

const rejectedCommand = (command: CommandEnvelope) => ({
  ok: false as const,
  commandId: command.id,
  rejectedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  reason: 'stub rejects commands',
})

const createStubAdapter = (
  id: string,
  packId: string,
  commandKind: string,
  config: { readonly queryKind?: string; readonly queryFailures?: number } = {},
): StubAdapter => {
  let connectCount = 0
  let closeCount = 0
  let queryFailures = config.queryFailures ?? 0
  const handlers = new Set<(emission: PackRuntimeEmission) => void>()
  const adapter: PackRuntimeAdapter = {
    id,
    version: '1.0.0',
    packId,
    clock: 'none',
    capabilities: [
      definePackCommandCapability({
        id: commandKind,
        title: commandKind,
        description: `Test command ${commandKind}`,
        idempotent: false,
        input: z.object({}).passthrough(),
        output: z.object({}).passthrough(),
        buildCommand: input => ({ targetObjectIds: [], payload: input }),
      }),
      ...(config.queryKind === undefined ? [] : [definePackQueryCapability({
        id: config.queryKind,
        title: config.queryKind,
        description: `Test query ${config.queryKind}`,
        input: z.object({}).strict(),
        output: z.object({ adapterId: z.string() }).strict(),
      })]),
    ],
    connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      connectCount += 1
      return {
        getSnapshot: async () => ({
          simulationRunId: config.simulationRunId,
          objects: [],
          capturedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
        }),
        subscribe: handler => {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
        sendCommand: async command => rejectedCommand(command),
        query: async request => {
          if (queryFailures > 0) {
            queryFailures -= 1
            throw new Error('stub query failure')
          }
          return {
            ok: true,
            packId: request.packId,
            kind: request.kind,
            result: { adapterId: id },
            generatedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
          }
        },
        observeCommittedEvents: async () => undefined,
        setClock: async (_clock: SimulationClockState) => undefined,
        close: async () => {
          closeCount += 1
        },
      }
    },
  }
  return {
    ...adapter,
    connectCount: () => connectCount,
    closeCount: () => closeCount,
    emit: emission => {
      for (const handler of handlers) handler(emission)
    },
  }
}

const command = (kind: string): CommandEnvelope => ({
  id: `command:${kind}` as CommandId,
  simulationRunId: 'run-test' as SimulationRunId,
  actorId: 'actor:test' as ActorId,
  kind,
  targetObjectIds: [],
  payload: {},
  issuedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
})

describe('createRuntimeHub', () => {
  test('connects only scenario-declared runtimes', async () => {
    const active = createStubAdapter('active.runtime', 'active-pack', 'world.active.command')
    const inactive = createStubAdapter('inactive.runtime', 'inactive-pack', 'world.inactive.command')
    const hub = createRuntimeHub([active, inactive])

    const connection = await hub.connect({
      simulationRunId: 'run-test' as SimulationRunId,
      scenario: {
        scenarioId: 'scenario:test',
        runtimeIds: ['active.runtime'],
        connections: [],
        world: { startsAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp, environment: { mode: 'test' } },
        initialObjects: [],
        runtimeConfigByRuntimeId: {},
        runtimeConfig: {},
      },
    })

    expect(active.connectCount()).toBe(1)
    expect(inactive.connectCount()).toBe(0)

    const inactiveCommand = await connection.sendCommand(command('inactive.command'))
    expect(inactiveCommand.ok).toBe(false)
    if (!inactiveCommand.ok) expect(inactiveCommand.reason).toMatch(/no pack runtime accepts/)

    await connection.close()
  })

  test('rejects ambiguous active command routes before connecting runtimes', async () => {
    const first = createStubAdapter('first.runtime', 'first-pack', 'world.shared.command')
    const second = createStubAdapter('second.runtime', 'second-pack', 'world.shared.command')
    const hub = createRuntimeHub([first, second])

    await expect(hub.connect({ simulationRunId: 'run-test' as SimulationRunId })).rejects.toThrow('duplicate command route')
    expect(first.connectCount()).toBe(0)
    expect(second.connectCount()).toBe(0)
  })

  test('drops emissions that claim another runtime or Pack identity', async () => {
    const adapter = createStubAdapter('trusted.runtime', 'trusted-pack', 'world.trusted.command')
    const connection = await createRuntimeHub([adapter]).connect({ simulationRunId: 'run-test' as SimulationRunId })
    const received: PackRuntimeEmission[] = []
    connection.subscribe(emission => received.push(emission))
    const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
    const baseEmission: PackRuntimeEmission = {
      type: 'event.emission',
      emittedAt: at,
      runtimeId: 'other.runtime',
      events: [],
    }

    adapter.emit(baseEmission)
    adapter.emit({
      ...baseEmission,
      runtimeId: 'trusted.runtime',
      events: [{
        type: 'object.upserted',
        at,
        history: 'record',
        provenance: { source: 'simulator' },
        object: {
          id: 'object:foreign' as ObjectId,
          kind: 'facility',
          packId: 'foreign-pack' as PackId,
          label: 'Foreign',
          lifecycle: 'active',
          revision: 0,
          spatial: { frame: { kind: 'wgs84' } },
          operational: { status: 'ready', priority: 'normal', mode: 'simulated' },
          alerts: [],
          provenance: { source: 'simulator' },
          timestamps: { createdAt: at, updatedAt: at },
          packData: {},
        },
      }],
    })

    expect(received).toEqual([])
    await connection.close()
    expect(adapter.closeCount()).toBe(1)
  })

  test('reports runtime failures and recovery without hiding the failure count', async () => {
    const adapter = createStubAdapter('health.runtime', 'health-pack', 'world.health.command', {
      queryKind: 'world.health.status',
      queryFailures: 1,
    })
    const connection = await createRuntimeHub([adapter]).connect({ simulationRunId: 'run-test' as SimulationRunId })

    await expect(connection.query({ packId: 'health-pack', kind: 'world.health.status', payload: {} }))
      .rejects.toThrow('stub query failure')
    expect(connection.health?.()).toEqual([expect.objectContaining({
      runtimeId: 'health.runtime',
      state: 'degraded',
      failureCount: 1,
      lastFailure: expect.objectContaining({ operation: 'world.health.status', message: 'stub query failure' }),
    })])

    expect((await connection.query({ packId: 'health-pack', kind: 'world.health.status', payload: {} })).ok).toBe(true)
    expect(connection.health?.()).toEqual([expect.objectContaining({
      runtimeId: 'health.runtime',
      state: 'ready',
      failureCount: 1,
    })])
    await connection.close()
  })
})
