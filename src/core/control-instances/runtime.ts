import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, DomainEvent, EventId, ControlInstanceId, InteractionEffect, InteractionHandler, InteractionSignal, IsoTimestamp, ObjectId, OperationalObject, Provenance } from '../model/index.ts'
import { deleteObjectCommandKind, deleteObjectPayloadSchema, interactionEffectSchema, interactionSignalSchema, nowIso } from '../model/index.ts'
import type { SimulationConnection, SimulationEmission, SimulationEvent } from '../../simulation/protocol.ts'
import type { EventLog } from './event-log.ts'
import { createControlInstanceStateStore, type ControlInstanceStateSnapshot } from './state-store.ts'
import type { ControlInstanceSnapshotStore } from './snapshot-store.ts'
import { canIssueCommand, type Actor } from './actors.ts'
import { persistenceDispositionFor } from './persistence-policy.ts'

export interface ControlInstanceEventNotification {
  readonly type: 'event.notification'
  readonly events: ReadonlyArray<DomainEvent>
}

export type ControlInstanceEventHandler = (event: ControlInstanceEventNotification) => void

export interface ControlInstanceRuntime {
  readonly id: ControlInstanceId
  readonly snapshot: () => ControlInstanceStateSnapshot
  readonly events: (config?: { readonly afterSeq?: number }) => ReadonlyArray<DomainEvent>
  readonly subscribe: (handler: ControlInstanceEventHandler) => () => void
  readonly issueCommand: (actor: Actor, command: CommandEnvelope) => Promise<CommandResult>
  readonly publishInteractionSignal: (signal: InteractionSignal, provenance: Provenance) => Promise<void>
  readonly close: () => Promise<void>
}

const eventId = (): EventId => `event:${randomUUID()}` as EventId

export const createControlInstanceRuntime = async (config: {
  readonly id: ControlInstanceId
  readonly simulation: SimulationConnection
  readonly eventLog: EventLog
  readonly snapshotStore: ControlInstanceSnapshotStore
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
  readonly restoredSnapshot?: ControlInstanceStateSnapshot
  readonly restoredEvents?: ReadonlyArray<DomainEvent>
}): Promise<ControlInstanceRuntime> => {
  const state = createControlInstanceStateStore()
  const handlers = new Set<ControlInstanceEventHandler>()
  const durableEvents: DomainEvent[] = [...(config.restoredEvents ?? [])]
  const restoredEventSeq = durableEvents.reduce((max, event) => Math.max(max, event.seq), 0)
  let seq = Math.max(config.restoredSnapshot?.seq ?? 0, restoredEventSeq)
  let publishQueue: Promise<void> = Promise.resolve()
  const interactionHandlers = [...(config.interactionHandlers ?? [])]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))

  const keepQueueOpenAfter = async (publish: Promise<void>): Promise<void> => {
    await Promise.allSettled([publish])
  }

  const publishManyNow = async (domainEvents: ReadonlyArray<DomainEvent>): Promise<void> => {
    if (domainEvents.length === 0) return
    const eventsToPersist: DomainEvent[] = []
    for (const event of domainEvents) {
      const previousObject = event.type === 'object.upserted' ? state.getObject(event.object.id) : undefined
      state.apply(event)
      if (persistenceDispositionFor(event, previousObject) === 'durable') {
        durableEvents.push(event)
        eventsToPersist.push(event)
      }
    }
    await config.eventLog.appendMany(eventsToPersist)
    await config.snapshotStore.save(state.snapshot())
    const notification: ControlInstanceEventNotification = { type: 'event.notification', events: domainEvents }
    for (const handler of handlers) handler(notification)
  }

  const enqueuePublish = async (work: () => Promise<void>): Promise<void> => {
    const previousPublish = publishQueue
    const currentPublish = (async (): Promise<void> => {
      await previousPublish
      await work()
    })()
    publishQueue = keepQueueOpenAfter(currentPublish)
    await currentPublish
  }

  const publishMany = async (domainEvents: ReadonlyArray<DomainEvent>): Promise<void> => {
    await enqueuePublish(async () => {
      await publishManyNow(domainEvents)
    })
  }

  const publish = async (event: DomainEvent): Promise<void> => {
    await publishMany([event])
  }

  const nextBase = (simEvent: SimulationEvent): Omit<DomainEvent, 'type'> => ({
    id: eventId(),
    controlInstanceId: config.id,
    seq: ++seq,
    at: simEvent.at,
    provenance: simEvent.provenance,
  })

  const domainEventFromSimulationEvent = (simEvent: SimulationEvent): DomainEvent => {
    if (simEvent.type === 'object.upserted') {
      return { ...nextBase(simEvent), type: 'object.upserted', object: simEvent.object }
    }
    if (simEvent.type === 'object.deleted') {
      return { ...nextBase(simEvent), type: 'object.deleted', objectId: simEvent.objectId }
    }
    if (simEvent.type === 'interaction.signal') {
      return { ...nextBase(simEvent), type: 'interaction.signal.received', signal: simEvent.signal }
    }
    return { ...nextBase(simEvent), type: 'telemetry.sampled', objectId: simEvent.objectId, telemetry: simEvent.telemetry }
  }

  const domainEventFromInteractionEffect = (
    effect: InteractionEffect,
    at: IsoTimestamp,
    provenance: Provenance,
  ): DomainEvent => {
    if (effect.type === 'object.upsert') {
      return {
        id: eventId(),
        controlInstanceId: config.id,
        seq: ++seq,
        at,
        provenance: effect.object.provenance,
        type: 'object.upserted',
        object: effect.object,
      }
    }
    if (effect.type === 'object.delete') {
      return {
        id: eventId(),
        controlInstanceId: config.id,
        seq: ++seq,
        at,
        provenance,
        type: 'object.deleted',
        objectId: effect.objectId,
      }
    }
    return {
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at,
      provenance,
      type: 'notification.emitted',
      notification: effect.notification,
    }
  }

  const clearDeletedObjectReference = (
    object: OperationalObject,
    deletedObjectId: ObjectId,
    at: IsoTimestamp,
    command: CommandEnvelope,
  ): OperationalObject | null => {
    if (object.tasking?.currentTaskId !== deletedObjectId) return null
    const { route: _route, ...spatialWithoutRoute } = object.spatial
    const { intent: _intent, ...operationalWithoutIntent } = object.operational
    const { tasking: _tasking, ...objectWithoutTasking } = object
    return {
      ...objectWithoutTasking,
      revision: object.revision + 1,
      spatial: {
        ...spatialWithoutRoute,
        ...(object.spatial.position
          ? {
              position: {
                ...object.spatial.position,
                speedMps: 0,
                observedAt: at,
              },
            }
          : {}),
      },
      operational: {
        ...operationalWithoutIntent,
        status: 'available',
      },
      provenance: {
        source: 'operator',
        causedByCommandId: command.id,
      },
      timestamps: {
        ...object.timestamps,
        updatedAt: at,
      },
    }
  }

  const coreDeleteEvents = (command: CommandEnvelope, at: IsoTimestamp): ReadonlyArray<DomainEvent> => {
    const payload = deleteObjectPayloadSchema.parse(command.payload)
    const snapshot = state.snapshot()
    const target = snapshot.objects.find(object => object.id === payload.objectId)
    if (!target) throw new Error(`cannot delete unknown object: ${payload.objectId}`)
    const cleanupEvents: DomainEvent[] = snapshot.objects.flatMap(object => {
      const cleaned = clearDeletedObjectReference(object, payload.objectId, at, command)
      return cleaned
        ? [{
            id: eventId(),
            controlInstanceId: config.id,
            seq: ++seq,
            at,
            provenance: cleaned.provenance,
            type: 'object.upserted' as const,
            object: cleaned,
          }]
        : []
    })
    return [
      ...cleanupEvents,
      {
        id: eventId(),
        controlInstanceId: config.id,
        seq: ++seq,
        at,
        provenance: { source: 'operator', causedByCommandId: command.id },
        type: 'object.deleted',
        objectId: payload.objectId,
      },
    ]
  }

  const handleCoreCommand = async (command: CommandEnvelope): Promise<CommandResult | null> => {
    if (command.kind !== deleteObjectCommandKind) return null
    const at = nowIso()
    try {
      const events = coreDeleteEvents(command, at)
      await publishMany(events)
      await config.simulation.observeCommittedEvents(events)
      return { ok: true, commandId: command.id, acceptedAt: at }
    } catch (error) {
      return {
        ok: false,
        commandId: command.id,
        rejectedAt: at,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const commitInteractionEffectsNow = async (
    effects: ReadonlyArray<InteractionEffect>,
    at: IsoTimestamp,
    provenance: Provenance,
  ): Promise<void> => {
    if (effects.length === 0) return
    const parsedEffects = effects.map(effect => interactionEffectSchema.parse(effect) as InteractionEffect)
    const domainEvents = parsedEffects.map(effect => domainEventFromInteractionEffect(effect, at, provenance))
    await publishManyNow(domainEvents)
    await config.simulation.observeCommittedEvents(domainEvents)
  }

  const handleInteractionSignalNow = async (
    signal: InteractionSignal,
    provenance: Provenance,
  ): Promise<void> => {
    const parsedSignal = interactionSignalSchema.parse(signal) as InteractionSignal
    if (parsedSignal.controlInstanceId !== config.id) {
      throw new Error(`interaction signal control instance mismatch: ${parsedSignal.controlInstanceId}`)
    }
    await publishManyNow([{
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at: parsedSignal.at,
      provenance,
      type: 'interaction.signal.received',
      signal: parsedSignal,
    }])
    for (const handler of interactionHandlers) {
      if (!handler.accepts(parsedSignal)) continue
      const effects = await handler.handle({
        signal: parsedSignal,
        snapshot: state.snapshot(),
        provenance,
      })
      await commitInteractionEffectsNow(effects, parsedSignal.at, provenance)
    }
  }

  const publishSimulationEmission = async (emission: SimulationEmission): Promise<void> => {
    await enqueuePublish(async () => {
      for (const event of emission.events) {
        if (event.type === 'interaction.signal') {
          await handleInteractionSignalNow(event.signal, event.provenance)
        } else {
          await publishManyNow([domainEventFromSimulationEvent(event)])
        }
      }
    })
  }

  const publishSimulationEmissionSafely = async (emission: SimulationEmission): Promise<void> => {
    try {
      await publishSimulationEmission(emission)
    } catch (err) {
      console.error(err)
    }
  }

  const unsubscribeSimulation = config.simulation.subscribe((emission) => {
    void publishSimulationEmissionSafely(emission)
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
    const result = await handleCoreCommand(command) ?? await config.simulation.sendCommand(command)
    await publishQueue
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
      return durableEvents.filter(event => event.seq > afterSeq)
    },
    subscribe: (handler: ControlInstanceEventHandler): (() => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    issueCommand,
    publishInteractionSignal: async (signal: InteractionSignal, provenance: Provenance): Promise<void> => {
      await enqueuePublish(async () => {
        await handleInteractionSignalNow(signal, provenance)
      })
    },
    close: async (): Promise<void> => {
      unsubscribeSimulation()
      await config.simulation.close()
      await publishQueue
      handlers.clear()
    },
  }
}
