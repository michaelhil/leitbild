import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, DomainEvent, EventId, SessionId } from '../model/index.ts'
import { nowIso } from '../model/index.ts'
import type { SimulationConnection, SimulationEvent } from '../../simulation/protocol.ts'
import type { EventLog } from './event-log.ts'
import { createSessionStateStore, type SessionStateSnapshot } from './state-store.ts'
import { canIssueCommand, type Participant } from './roles.ts'

export type SessionEventHandler = (event: DomainEvent) => void

export interface StudySession {
  readonly id: SessionId
  readonly snapshot: () => SessionStateSnapshot
  readonly subscribe: (handler: SessionEventHandler) => () => void
  readonly issueCommand: (participant: Participant, command: CommandEnvelope) => Promise<CommandResult>
  readonly close: () => Promise<void>
}

const eventId = (): EventId => `event:${randomUUID()}` as EventId

export const createStudySession = async (config: {
  readonly id: SessionId
  readonly simulation: SimulationConnection
  readonly eventLog: EventLog
}): Promise<StudySession> => {
  const state = createSessionStateStore()
  const handlers = new Set<SessionEventHandler>()
  let seq = 0

  const publish = async (event: DomainEvent): Promise<void> => {
    state.apply(event)
    await config.eventLog.append(event)
    for (const handler of handlers) handler(event)
  }

  const nextBase = (simEvent: SimulationEvent): Omit<DomainEvent, 'type'> => ({
    id: eventId(),
    sessionId: config.id,
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

  const snapshot = await config.simulation.getSnapshot()
  for (const object of snapshot.objects) {
    await publish({
      id: eventId(),
      sessionId: config.id,
      seq: ++seq,
      at: snapshot.capturedAt,
      provenance: object.provenance,
      type: 'object.upserted',
      object,
    })
  }

  const issueCommand = async (participant: Participant, command: CommandEnvelope): Promise<CommandResult> => {
    if (command.sessionId !== config.id) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: 'command session does not match active session' }
    }
    if (!canIssueCommand(participant, command)) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: `role ${participant.role} may not issue command ${command.kind}` }
    }
    await publish({
      id: eventId(),
      sessionId: config.id,
      seq: ++seq,
      at: command.issuedAt,
      provenance: { source: 'operator' },
      type: 'command.issued',
      command,
    })
    const result = await config.simulation.sendCommand(command)
    await publish({
      id: eventId(),
      sessionId: config.id,
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
    subscribe: (handler: SessionEventHandler): (() => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    issueCommand,
    close: async (): Promise<void> => {
      unsubscribeSimulation()
      handlers.clear()
      await config.simulation.close()
    },
  }
}
