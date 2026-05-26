import { nowIso, type CommandEnvelope, type CommandResult, type DomainEvent, type SimulationClockState } from '../../../core/model/index.ts'
import type {
  SimulationAdapter,
  SimulationConnection,
  SimulationConnectionConfig,
  SimulationEventHandler,
} from '../../../simulation/protocol.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { aviationDomain, aviationNoopAdapterId, aviationNoopProviderId } from './constants.ts'

// Phase B.1 placeholder. Emits no aircraft, accepts no commands, holds no
// state. Real OpenSky / VATSIM providers replace it in B.2 / B.3.

export const createAviationNoopSimulationAdapter = (): SimulationAdapter => ({
  id: aviationNoopProviderId,
  packId: 'aviation',
  domain: aviationDomain,
  acceptedCommandKinds: [],
  queryKinds: [],
  connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
    let clock: SimulationClockState = {
      currentTime: config.scenario?.world.startsAt ?? nowIso(),
      updatedAt: nowIso(),
      paused: false,
      speed: 1,
    }
    const handlers = new Set<SimulationEventHandler>()
    return {
      getSnapshot: async () => ({
        controlInstanceId: config.controlInstanceId,
        objects: [],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: SimulationEventHandler): (() => void) => {
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => ({
        ok: false,
        commandId: command.id,
        rejectedAt: nowIso(),
        reason: `aviation noop provider rejects all commands (kind=${command.kind})`,
      }),
      query: async (request: PackQueryRequest): Promise<PackQueryResponse> => ({
        ok: false,
        packId: request.packId,
        kind: request.kind,
        reason: 'aviation noop provider answers no queries in Phase B.1',
        generatedAt: nowIso(),
      }),
      observeCommittedEvents: async (_events: ReadonlyArray<DomainEvent>): Promise<void> => undefined,
      setClock: async (next: SimulationClockState): Promise<void> => { clock = next },
      close: async (): Promise<void> => { handlers.clear() },
    }
  },
})

export const aviationNoopProvider = { id: aviationNoopProviderId, label: 'Aviation noop (Phase B.1 placeholder)', kind: 'local' as const }

export { aviationNoopAdapterId, aviationNoopProviderId }
