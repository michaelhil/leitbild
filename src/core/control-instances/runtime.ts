import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, DomainEvent, EventId, ControlInstanceId } from '../model/index.ts'
import { nowIso } from '../model/index.ts'
import type { SimulationConnection, SimulationEvent } from '../../simulation/protocol.ts'
import type { EventLog } from './event-log.ts'
import { createControlInstanceStateStore, type ControlInstanceStateSnapshot } from './state-store.ts'
import type { ControlInstanceSnapshotStore } from './snapshot-store.ts'
import { canIssueCommand, type Actor } from './actors.ts'

export type ControlInstanceEventHandler = (event: DomainEvent) => void

export interface ControlInstanceRuntime {
  readonly id: ControlInstanceId
  readonly snapshot: () => ControlInstanceStateSnapshot
  readonly events: (config?: { readonly afterSeq?: number }) => ReadonlyArray<DomainEvent>
  readonly subscribe: (handler: ControlInstanceEventHandler) => () => void
  readonly issueCommand: (actor: Actor, command: CommandEnvelope) => Promise<CommandResult>
  readonly close: () => Promise<void>
}

const eventId = (): EventId => `event:${randomUUID()}` as EventId

export const createControlInstanceRuntime = async (config: {
  readonly id: ControlInstanceId
  readonly simulation: SimulationConnection
  readonly eventLog: EventLog
  readonly snapshotStore: ControlInstanceSnapshotStore
  readonly restoredSnapshot?: ControlInstanceStateSnapshot
  readonly restoredEvents?: ReadonlyArray<DomainEvent>
}): Promise<ControlInstanceRuntime> => {
  const state = createControlInstanceStateStore()
  const handlers = new Set<ControlInstanceEventHandler>()
  const events: DomainEvent[] = [...(config.restoredEvents ?? [])]
  const restoredEventSeq = events.reduce((max, event) => Math.max(max, event.seq), 0)
  let seq = Math.max(config.restoredSnapshot?.seq ?? 0, restoredEventSeq)
  let publishQueue: Promise<void> = Promise.resolve()

  const publishNow = async (event: DomainEvent): Promise<void> => {
    state.apply(event)
    events.push(event)
    await config.eventLog.append(event)
    await config.snapshotStore.save(state.snapshot())
    for (const handler of handlers) handler(event)
  }

  const publish = async (event: DomainEvent): Promise<void> => {
    publishQueue = publishQueue.then(() => publishNow(event))
    await publishQueue
  }

  const nextBase = (simEvent: SimulationEvent): Omit<DomainEvent, 'type'> => ({
    id: eventId(),
    controlInstanceId: config.id,
    seq: ++seq,
    at: simEvent.at,
    provenance: simEvent.provenance,
  })

  const publishSimulationEvent = async (simEvent: SimulationEvent): Promise<void> => {
    if (simEvent.type === 'object.upserted') {
      await publish({ ...nextBase(simEvent), type: 'object.upserted', object: simEvent.object })
      return
    }
    if (simEvent.type === 'object.deleted') {
      await publish({ ...nextBase(simEvent), type: 'object.deleted', objectId: simEvent.objectId })
      return
    }
    await publish({ ...nextBase(simEvent), type: 'telemetry.sampled', objectId: simEvent.objectId, telemetry: simEvent.telemetry })
  }

  const unsubscribeSimulation = config.simulation.subscribe((event) => {
    void publishSimulationEvent(event)
  })

  if (config.restoredSnapshot) {
    state.hydrate(config.restoredSnapshot)
  } else {
    const snapshot = await config.simulation.getSnapshot()
    state.hydrate({ objects: snapshot.objects, seq })
    await config.snapshotStore.save(state.snapshot())
  }

  const issueCommand = async (actor: Actor, command: CommandEnvelope): Promise<CommandResult> => {
    if (command.controlInstanceId !== config.id) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: 'command control instance does not match active control instance' }
    }
    if (!canIssueCommand(actor, command)) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: `role ${actor.role} may not issue command ${command.kind}` }
    }
    await publish({
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at: command.issuedAt,
      provenance: { source: 'operator' },
      type: 'command.issued',
      command,
    })
    const result = await config.simulation.sendCommand(command)
    await publish({
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at: result.ok ? result.acceptedAt : result.rejectedAt,
      provenance: { source: 'simulator', causedByCommandId: command.id },
      type: 'command.result',
      result,
    })
    return result
  }

  return {
    id: config.id,
    snapshot: () => state.snapshot(),
    events: (eventsConfig?: { readonly afterSeq?: number }): ReadonlyArray<DomainEvent> => {
      const afterSeq = eventsConfig?.afterSeq ?? -1
      return events.filter(event => event.seq > afterSeq)
    },
    subscribe: (handler: ControlInstanceEventHandler): (() => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    issueCommand,
    close: async (): Promise<void> => {
      await publishQueue
      unsubscribeSimulation()
      handlers.clear()
      await config.simulation.close()
    },
  }
}
