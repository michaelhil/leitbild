import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, DomainEvent, EventId, ControlInstanceId, InteractionEffect, InteractionHandler, InteractionSignal, IsoTimestamp, ObjectId, OperationalObject, Provenance, ScenarioInstanceState, ScenarioScript, ScenarioScriptAction, ScenarioScriptStep, SimulationClockState, SimulationClockUpdate } from '../model/index.ts'
import { deleteObjectCommandKind, deleteObjectPayloadSchema, interactionEffectSchema, interactionSignalSchema, nowIso, simulationClockUpdateSchema } from '../model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../packs/protocol.ts'
import type { SimulationConnection, SimulationEmission, SimulationEvent } from '../../simulation/protocol.ts'
import type { EventLog } from './event-log.ts'
import { createControlInstanceStateStore, type ControlInstanceStateSnapshot } from './state-store.ts'
import type { ControlInstanceSnapshotStore } from './snapshot-store.ts'
import { canIssueCommand, type Actor } from './actors.ts'
import { persistenceDispositionFor } from './persistence-policy.ts'
import { createScenarioScriptRunner, dueScenarioScriptSteps, type ScenarioScriptRunner } from './scenario-runner.ts'

export interface ControlInstanceEventNotification {
  readonly type: 'event.notification'
  readonly events: ReadonlyArray<DomainEvent>
}

export type ControlInstanceEventHandler = (event: ControlInstanceEventNotification) => void

export interface ControlInstanceRuntime {
  readonly id: ControlInstanceId
  readonly snapshot: () => ControlInstanceStateSnapshot
  readonly setClock: (update: SimulationClockUpdate) => Promise<SimulationClockState>
  readonly events: (config?: { readonly afterSeq?: number }) => ReadonlyArray<DomainEvent>
  readonly subscribe: (handler: ControlInstanceEventHandler) => () => void
  readonly issueCommand: (actor: Actor, command: CommandEnvelope) => Promise<CommandResult>
  readonly queryPack: (request: PackQueryRequest) => Promise<PackQueryResponse>
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
  readonly scenario?: {
    readonly id: string
    readonly startsAt?: IsoTimestamp
    readonly script?: ScenarioScript
  }
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

  const deriveClock = (clock: SimulationClockState): SimulationClockState => {
    if (clock.paused) return clock
    const updatedAtMs = Date.parse(clock.updatedAt)
    const currentTimeMs = Date.parse(clock.currentTime)
    const nowMs = Date.now()
    if (!Number.isFinite(updatedAtMs) || !Number.isFinite(currentTimeMs)) return clock
    return {
      ...clock,
      currentTime: new Date(currentTimeMs + Math.max(0, nowMs - updatedAtMs) * clock.speed).toISOString() as IsoTimestamp,
      updatedAt: nowIso(),
    }
  }

  const snapshotWithCurrentClock = (): ControlInstanceStateSnapshot => {
    const snapshot = state.snapshot()
    if (!snapshot.clock) return snapshot
    return {
      ...snapshot,
      clock: deriveClock(snapshot.clock),
    }
  }

  const currentClockMs = (): number => {
    const clock = snapshotWithCurrentClock().clock
    if (!clock) return Date.now()
    const currentTimeMs = Date.parse(clock.currentTime)
    if (!Number.isFinite(currentTimeMs)) throw new Error(`invalid control instance clock time: ${clock.currentTime}`)
    return currentTimeMs
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
    await config.snapshotStore.save(snapshotWithCurrentClock())
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

  const nextScenarioBase = (at: IsoTimestamp): Omit<DomainEvent, 'type'> => ({
    id: eventId(),
    controlInstanceId: config.id,
    seq: ++seq,
    at,
    provenance: { source: 'system' },
  })

  const domainEventFromScenarioAction = (
    action: ScenarioScriptAction,
    at: IsoTimestamp,
  ): DomainEvent => {
    if (action.type === 'show_guidance') {
      return { ...nextScenarioBase(at), type: 'scenario.guidance.shown', guidance: action.guidance }
    }
    if (action.type === 'hide_guidance') {
      return {
        ...nextScenarioBase(at),
        type: 'scenario.guidance.hidden',
        ...(action.guidanceId === undefined ? {} : { guidanceId: action.guidanceId }),
      }
    }
    if (action.type === 'highlight_objects') {
      return { ...nextScenarioBase(at), type: 'scenario.objects.highlighted', objectIds: action.objectIds }
    }
    if (action.type === 'clear_highlights') {
      return {
        ...nextScenarioBase(at),
        type: 'scenario.highlights.cleared',
        ...(action.objectIds === undefined ? {} : { objectIds: action.objectIds }),
      }
    }
    if (action.type === 'upsert_object') {
      return { ...nextScenarioBase(at), type: 'object.upserted', object: action.object }
    }
    return { ...nextScenarioBase(at), type: 'object.deleted', objectId: action.objectId }
  }

  const domainEventsForScenarioStep = (step: ScenarioScriptStep, at: IsoTimestamp): ReadonlyArray<DomainEvent> => [
    {
      ...nextScenarioBase(at),
      type: 'scenario.step.started',
      stepId: step.id,
    },
    ...step.actions.map(action => domainEventFromScenarioAction(action, at)),
  ]

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
      operational: operationalWithoutIntent,
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

  const initialScenarioState = (): ScenarioInstanceState | undefined => {
    if (!config.scenario) return undefined
    return {
      scenarioId: config.scenario.id,
      highlightedObjectIds: [],
      ...(config.scenario.script === undefined
        ? {}
        : {
            script: {
              startedAt: config.scenario.startsAt ?? nowIso(),
              firedStepIds: [],
            },
          }),
    }
  }

  if (config.restoredSnapshot) {
    state.hydrate({
      ...config.restoredSnapshot,
      clock: config.restoredSnapshot.clock ?? {
        currentTime: config.scenario?.startsAt ?? nowIso(),
        updatedAt: nowIso(),
        paused: false,
        speed: 1,
      },
    })
  } else {
    const snapshot = await config.simulation.getSnapshot()
    const scenarioState = initialScenarioState()
    state.hydrate({
      objects: snapshot.objects,
      seq,
      clock: {
        currentTime: config.scenario?.startsAt ?? nowIso(),
        updatedAt: nowIso(),
        paused: false,
        speed: 1,
      },
      ...(scenarioState === undefined ? {} : { scenario: scenarioState }),
    })
    await config.snapshotStore.save(snapshotWithCurrentClock())
  }
  const hydratedClock = state.snapshot().clock
  if (hydratedClock) await config.simulation.setClock(hydratedClock)

  let scenarioRunner: ScenarioScriptRunner | null = null

  const runDueScenarioSteps = async (): Promise<void> => {
    if (!config.scenario?.script || !state.snapshot().scenario?.script) return
    const dueSteps = dueScenarioScriptSteps({
      script: config.scenario.script,
      state: state.snapshot().scenario!,
      nowMs: currentClockMs(),
    })
    for (const step of dueSteps) {
      const events = domainEventsForScenarioStep(step, nowIso())
      await publishMany(events)
      await config.simulation.observeCommittedEvents(events)
    }
  }

  const startScenarioRunner = (): void => {
    scenarioRunner?.close()
    scenarioRunner = null
    const clock = state.snapshot().clock
    if (clock?.paused) return
    const runnerScenarioState = state.snapshot().scenario
    if (!config.scenario?.script || !runnerScenarioState?.script) return
    scenarioRunner = createScenarioScriptRunner({
      script: config.scenario.script,
      state: runnerScenarioState,
      nowMs: currentClockMs,
      delayMs: (dueAtMs, nowMs): number => {
        const speed = state.snapshot().clock?.speed ?? 1
        return Math.max(0, (dueAtMs - nowMs) / speed)
      },
      onStepDue: async (step): Promise<void> => {
        const events = domainEventsForScenarioStep(step, nowIso())
        await publishMany(events)
        await config.simulation.observeCommittedEvents(events)
      },
    })
    scenarioRunner?.start()
  }

  if (config.scenario?.script && state.snapshot().scenario?.script) {
    await runDueScenarioSteps()
    startScenarioRunner()
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

  const setClock = async (update: SimulationClockUpdate): Promise<SimulationClockState> => {
    const parsedUpdate = simulationClockUpdateSchema.parse(update) as SimulationClockUpdate
    const currentClock = state.snapshot().clock
    if (!currentClock) throw new Error('control instance clock is not initialized')
    const current = deriveClock(currentClock)
    const at = nowIso()
    const nextClock: SimulationClockState = {
      currentTime: parsedUpdate.currentTime ?? current.currentTime,
      updatedAt: at,
      paused: parsedUpdate.paused ?? current.paused,
      speed: parsedUpdate.speed ?? current.speed,
    }
    await publish({
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at,
      provenance: { source: 'operator' },
      type: 'clock.updated',
      clock: nextClock,
    })
    await config.simulation.setClock(nextClock)
    if (config.scenario?.script) {
      if (nextClock.paused) {
        scenarioRunner?.close()
        scenarioRunner = null
      } else {
        await runDueScenarioSteps()
        startScenarioRunner()
      }
    }
    return nextClock
  }

  const queryPack = async (request: PackQueryRequest): Promise<PackQueryResponse> =>
    await config.simulation.query(request)

  return {
    id: config.id,
    snapshot: () => snapshotWithCurrentClock(),
    setClock,
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
    queryPack,
    publishInteractionSignal: async (signal: InteractionSignal, provenance: Provenance): Promise<void> => {
      await enqueuePublish(async () => {
        await handleInteractionSignalNow(signal, provenance)
      })
    },
    close: async (): Promise<void> => {
      scenarioRunner?.close()
      unsubscribeSimulation()
      await config.simulation.close()
      await publishQueue
      handlers.clear()
    },
  }
}
