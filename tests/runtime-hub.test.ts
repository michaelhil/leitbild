import { describe, expect, test } from 'bun:test'
import type {
  ActorId,
  CommandEnvelope,
  CommandId,
  ControlInstanceId,
  IsoTimestamp,
  SimulationClockState,
} from '../src/core/model/index.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
} from '../src/simulation/protocol.ts'

interface StubAdapter extends PackRuntimeAdapter {
  readonly connectCount: () => number
}

const rejectedCommand = (command: CommandEnvelope) => ({
  ok: false as const,
  commandId: command.id,
  rejectedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  reason: 'stub rejects commands',
})

const createStubAdapter = (id: string, packId: string, commandKind: string): StubAdapter => {
  let connectCount = 0
  const adapter: PackRuntimeAdapter = {
    id,
    packId,
    acceptedCommandKinds: [commandKind],
    connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      connectCount += 1
      return {
        getSnapshot: async () => ({
          controlInstanceId: config.controlInstanceId,
          objects: [],
          capturedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
        }),
        subscribe: () => () => undefined,
        sendCommand: async command => rejectedCommand(command),
        query: async request => ({
          ok: true,
          packId: request.packId,
          kind: request.kind,
          result: { adapterId: id },
          generatedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
        }),
        observeCommittedEvents: async () => undefined,
        setClock: async (_clock: SimulationClockState) => undefined,
        close: async () => undefined,
      }
    },
  }
  return { ...adapter, connectCount: () => connectCount }
}

const command = (kind: string): CommandEnvelope => ({
  id: `command:${kind}` as CommandId,
  controlInstanceId: 'control-instance:test' as ControlInstanceId,
  actorId: 'actor:test' as ActorId,
  kind,
  targetObjectIds: [],
  payload: {},
  issuedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
})

describe('createRuntimeHub', () => {
  test('connects only scenario-declared runtimes', async () => {
    const active = createStubAdapter('active.runtime', 'active-pack', 'active.command')
    const inactive = createStubAdapter('inactive.runtime', 'inactive-pack', 'inactive.command')
    const hub = createRuntimeHub([active, inactive])

    const connection = await hub.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
      scenario: {
        scenarioId: 'scenario:test',
        runtimeIds: ['active.runtime'],
        world: { startsAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp, environment: { mode: 'test' } },
        initialObjects: [],
        runtimeConfigs: {},
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
})
