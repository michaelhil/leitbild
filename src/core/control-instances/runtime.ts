import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, ControlInstanceEvent, EventId, ControlInstanceId, InteractionEffect, InteractionHandler, InteractionSignal, IsoTimestamp, ObjectId, OperationalObject, ProcedureCatalog, ProcedureDocument, ProcedureId, ProcedureSourceId, Provenance, ScenarioInstanceState, ScenarioScript, ScenarioScriptAction, ScenarioScriptStep, SimulationClockState, SimulationClockUpdate } from '../model/index.ts'
import { actorIdSchema, commandEnvelopeSchema, deleteObjectCommandKind, deleteObjectPayloadSchema, interactionEffectSchema, interactionSignalSchema, notificationIdSchema, nowIso, simulationClockUpdateSchema } from '../model/index.ts'
import type { PackQueryRequest, PackQueryResponse, PackWikiRef } from '../packs/protocol.ts'
import type { PackRuntimeConnection, PackRuntimeEmission, PackRuntimeEvent } from '../../simulation/protocol.ts'
import type { EventLog } from './event-log.ts'
import { createControlInstanceStateStore, type ControlInstanceStateSnapshot } from './state-store.ts'
import type { ControlInstanceSnapshotStore } from './snapshot-store.ts'
import { canIssueCommand, type Actor } from './actors.ts'
import { persistenceDispositionFor, type ControlInstanceEventPersistenceDisposition } from './persistence-policy.ts'
import { createScenarioScriptRunner, dueScenarioScriptSteps, type ScenarioScriptRunner } from './scenario-runner.ts'
import {
  createControlInstanceRuntimeMetricsRecorder,
  type ControlInstanceRuntimeMetricsSnapshot,
} from './runtime-metrics.ts'
import { defaultControlInstanceRuntimePolicy } from './runtime-persistence-policy.ts'
import { createProcedureSourceService, type ProcedureSourceLoadStatus, type ProcedureSourceService } from '../procedures/source.ts'
import { procedureCommandEvents } from '../procedures/run-state.ts'

const projectedSnapshotFlushIntervalMs = defaultControlInstanceRuntimePolicy.projectedSnapshotFlushIntervalMs
const scenarioRunnerActor: Actor = {
  id: actorIdSchema.parse('actor:scenario-runner'),
  label: 'Scenario runner',
  role: 'system',
}

interface PublishManyOptions {
  readonly persistence?: ControlInstanceEventPersistenceDisposition
  readonly persistenceForEvent?: (
    event: ControlInstanceEvent,
    previousObject: OperationalObject | undefined,
    index: number,
  ) => ControlInstanceEventPersistenceDisposition | undefined
}

export interface ControlInstanceEventNotification {
  readonly type: 'event.notification'
  readonly events: ReadonlyArray<ControlInstanceEvent>
}

export type ControlInstanceEventHandler = (event: ControlInstanceEventNotification) => void

export interface ControlInstanceRuntime {
  readonly id: ControlInstanceId
  readonly capabilities: () => ControlInstanceCapabilities
  readonly snapshot: () => ControlInstanceStateSnapshot
  readonly setClock: (update: SimulationClockUpdate) => Promise<SimulationClockState>
  readonly events: (config?: { readonly afterSeq?: number }) => ReadonlyArray<ControlInstanceEvent>
  readonly subscribe: (handler: ControlInstanceEventHandler) => () => void
  readonly publishResetBoundary: (config: { readonly scenarioId?: string }) => Promise<ControlInstanceEvent>
  readonly issueCommand: (actor: Actor, command: CommandEnvelope) => Promise<CommandResult>
  readonly queryPack: (request: PackQueryRequest) => Promise<PackQueryResponse>
  readonly procedureSourceStatus: (config?: { readonly sourceId?: ProcedureSourceId }) => ProcedureSourceLoadStatus
  readonly procedureCatalog: (config?: { readonly sourceId?: ProcedureSourceId; readonly refresh?: boolean }) => Promise<ProcedureCatalog>
  readonly procedureDocument: (config: { readonly sourceId?: ProcedureSourceId; readonly procedureId: ProcedureId; readonly refresh?: boolean }) => Promise<ProcedureDocument>
  readonly publishInteractionSignal: (signal: InteractionSignal, provenance: Provenance) => Promise<void>
  readonly metrics: () => ControlInstanceRuntimeMetricsSnapshot
  readonly close: () => Promise<void>
}

export interface ControlInstanceCapabilities {
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId: string | null
  readonly activePackIds: ReadonlyArray<string>
  readonly acceptedCommandKinds: ReadonlyArray<string>
  readonly queryKinds: Readonly<Record<string, ReadonlyArray<string>>>
  readonly wikiRefs: ReadonlyArray<PackWikiRef>
}

const eventId = (): EventId => `event:${randomUUID()}` as EventId

export const createControlInstanceRuntime = async (config: {
  readonly id: ControlInstanceId
  readonly runtimeConnection: PackRuntimeConnection
  readonly eventLog: EventLog
  readonly snapshotStore: ControlInstanceSnapshotStore
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
  readonly restoredSnapshot?: ControlInstanceStateSnapshot
  readonly restoredEvents?: ReadonlyArray<ControlInstanceEvent>
  readonly initialSeq?: number
  readonly scenario?: {
    readonly id: string
    readonly startsAt?: IsoTimestamp
    readonly script?: ScenarioScript
  }
  readonly capabilities?: Omit<ControlInstanceCapabilities, 'controlInstanceId'>
  readonly procedureSourceService?: ProcedureSourceService
}): Promise<ControlInstanceRuntime> => {
  const state = createControlInstanceStateStore()
  const metrics = createControlInstanceRuntimeMetricsRecorder({
    controlInstanceId: config.id,
    createdAt: nowIso(),
  })
  const handlers = new Set<ControlInstanceEventHandler>()
  const durableEvents: ControlInstanceEvent[] = [...(config.restoredEvents ?? [])]
  const restoredEventSeq = durableEvents.reduce((max, event) => Math.max(max, event.seq), 0)
  let seq = Math.max(config.initialSeq ?? 0, config.restoredSnapshot?.seq ?? 0, restoredEventSeq)
  let publishQueue: Promise<void> = Promise.resolve()
  let snapshotSaveQueue: Promise<void> = Promise.resolve()
  let projectedSnapshotDirty = false
  let projectedSnapshotTimer: ReturnType<typeof setTimeout> | null = null
  const interactionHandlers = [...(config.interactionHandlers ?? [])]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
  const procedureSourceService = config.procedureSourceService ?? createProcedureSourceService()

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

  const clearProjectedSnapshotTimer = (): void => {
    if (projectedSnapshotTimer === null) return
    clearTimeout(projectedSnapshotTimer)
    projectedSnapshotTimer = null
  }

  const queueSnapshotSave = async (): Promise<void> => {
    const previousSave = snapshotSaveQueue
    const save = async (): Promise<void> => {
      try {
        await previousSave
      } catch (err) {
        void err
      }
      const startedAt = performance.now()
      try {
        await config.snapshotStore.save(snapshotWithCurrentClock())
        metrics.recordSnapshotSave(performance.now() - startedAt, nowIso())
      } catch (err) {
        metrics.recordSnapshotSaveFailure()
        throw err
      }
    }
    const currentSave = save()
    snapshotSaveQueue = (async (): Promise<void> => {
      try {
        await currentSave
      } catch (err) {
        void err
      }
    })()
    await currentSave
  }

  const saveSnapshotImmediately = async (): Promise<void> => {
    clearProjectedSnapshotTimer()
    projectedSnapshotDirty = false
    metrics.recordImmediateSnapshotSave()
    await queueSnapshotSave()
  }

  const scheduleProjectedSnapshotSave = (): void => {
    metrics.recordProjectedSnapshotScheduled()
    projectedSnapshotDirty = true
    if (projectedSnapshotTimer !== null) return
    projectedSnapshotTimer = setTimeout(() => {
      projectedSnapshotTimer = null
      if (!projectedSnapshotDirty) return
      projectedSnapshotDirty = false
      metrics.recordProjectedSnapshotFlushed()
      const save = async (): Promise<void> => {
        try {
          await queueSnapshotSave()
        } catch (err) {
          console.error('control instance projected snapshot save failed:', err)
        }
      }
      void save()
    }, projectedSnapshotFlushIntervalMs)
    projectedSnapshotTimer.unref?.()
  }

  const flushProjectedSnapshot = async (): Promise<void> => {
    clearProjectedSnapshotTimer()
    if (projectedSnapshotDirty) {
      projectedSnapshotDirty = false
      metrics.recordProjectedSnapshotFlushed()
      await queueSnapshotSave()
      return
    }
    await snapshotSaveQueue
  }

  const publishManyNow = async (
    controlInstanceEvents: ReadonlyArray<ControlInstanceEvent>,
    options?: PublishManyOptions,
  ): Promise<void> => {
    if (controlInstanceEvents.length === 0) return
    const eventsToPersist: ControlInstanceEvent[] = []
    let projectedEventCount = 0
    for (const [index, event] of controlInstanceEvents.entries()) {
      const previousObject = event.type === 'object.upserted' ? state.getObject(event.object.id) : undefined
      state.apply(event)
      const persistence = options?.persistence
        ?? options?.persistenceForEvent?.(event, previousObject, index)
        ?? persistenceDispositionFor(event, previousObject)
      if (persistence === 'durable') {
        durableEvents.push(event)
        eventsToPersist.push(event)
      } else {
        projectedEventCount += 1
      }
    }
    metrics.recordPublishedEvents({
      eventCount: controlInstanceEvents.length,
      durableEventCount: eventsToPersist.length,
      projectedEventCount,
    })
    await config.eventLog.appendMany(eventsToPersist)
    if (eventsToPersist.length > 0) {
      await saveSnapshotImmediately()
    } else {
      scheduleProjectedSnapshotSave()
    }
    const notification: ControlInstanceEventNotification = { type: 'event.notification', events: controlInstanceEvents }
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

  const publishGenerated = async (
    generate: () => ReadonlyArray<ControlInstanceEvent> | Promise<ReadonlyArray<ControlInstanceEvent>>,
    options?: PublishManyOptions,
  ): Promise<ReadonlyArray<ControlInstanceEvent>> => {
    let generatedEvents: ReadonlyArray<ControlInstanceEvent> = []
    await enqueuePublish(async () => {
      generatedEvents = await generate()
      await publishManyNow(generatedEvents, options)
    })
    return generatedEvents
  }

  const publishOneGenerated = async (
    generate: () => ControlInstanceEvent | Promise<ControlInstanceEvent>,
    options?: PublishManyOptions,
  ): Promise<ControlInstanceEvent> => {
    const events = await publishGenerated(async () => [await generate()], options)
    const event = events[0]
    if (!event) throw new Error('internal event generation produced no event')
    return event
  }

  const nextScenarioBase = (at: IsoTimestamp): Omit<ControlInstanceEvent, 'type'> => ({
    id: eventId(),
    controlInstanceId: config.id,
    seq: ++seq,
    at,
    provenance: { source: 'system' },
  })

  const controlInstanceEventFromScenarioAction = (
    action: ScenarioScriptAction,
    at: IsoTimestamp,
  ): ControlInstanceEvent | null => {
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
    if (action.type === 'emit_signal' || action.type === 'issue_command') return null
    return { ...nextScenarioBase(at), type: 'object.deleted', objectId: action.objectId }
  }

  const scenarioSignalForAction = (
    action: Extract<ScenarioScriptAction, { readonly type: 'emit_signal' }>,
    at: IsoTimestamp,
  ): InteractionSignal => ({
    id: action.signal.id,
    controlInstanceId: config.id,
    at,
    source: action.signal.source,
    targets: action.signal.targets,
    type: action.signal.signalType,
    payload: action.signal.payload,
    ...(action.signal.severity === undefined ? {} : { severity: action.signal.severity }),
    ...(action.signal.correlationId === undefined ? {} : { correlationId: action.signal.correlationId }),
    ...(action.signal.causationId === undefined ? {} : { causationId: action.signal.causationId }),
    ...(action.signal.ttlMs === undefined ? {} : { ttlMs: action.signal.ttlMs }),
  })

  const scenarioStepStartedEvent = (step: ScenarioScriptStep, at: IsoTimestamp): ControlInstanceEvent => ({
    ...nextScenarioBase(at),
    type: 'scenario.step.started',
    stepId: step.id,
  })

  const scenarioStepFailedEvent = (step: ScenarioScriptStep, error: unknown, at: IsoTimestamp): ControlInstanceEvent => ({
    ...nextScenarioBase(at),
    type: 'notification.emitted',
    notification: {
      id: notificationIdSchema.parse(`notification:scenario-step-failed:${step.id}:${randomUUID()}`),
      controlInstanceId: config.id,
      at,
      title: 'Scenario step failed',
      message: `Scenario step ${step.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'critical',
      source: { kind: 'simulation', id: 'scenario-runner' },
      targets: [{ kind: 'broadcast' }],
    },
  })

  const controlInstanceEventsForScenarioActions = (actions: ReadonlyArray<ScenarioScriptAction>, at: IsoTimestamp): ReadonlyArray<ControlInstanceEvent> =>
    actions
      .map(action => controlInstanceEventFromScenarioAction(action, at))
      .filter((event): event is ControlInstanceEvent => event !== null)

  const nextBase = (simEvent: PackRuntimeEvent): Omit<ControlInstanceEvent, 'type'> => ({
    id: eventId(),
    controlInstanceId: config.id,
    seq: ++seq,
    at: simEvent.at,
    provenance: simEvent.provenance,
  })

  const controlInstanceEventFromPackRuntimeEvent = (simEvent: PackRuntimeEvent): ControlInstanceEvent => {
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

  const persistenceForPackRuntimeEvent = (
    event: PackRuntimeEvent,
  ): ControlInstanceEventPersistenceDisposition | undefined => {
    if (event.persistence !== undefined) return event.persistence
    if (
      event.type === 'object.upserted'
      || event.type === 'object.deleted'
      || event.type === 'telemetry.sampled'
    ) return 'projected'
    return undefined
  }

  const controlInstanceEventFromInteractionEffect = (
    effect: InteractionEffect,
    at: IsoTimestamp,
    provenance: Provenance,
  ): ControlInstanceEvent => {
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

  const coreDeleteEvents = (command: CommandEnvelope, at: IsoTimestamp): ReadonlyArray<ControlInstanceEvent> => {
    const payload = deleteObjectPayloadSchema.parse(command.payload)
    const snapshot = state.snapshot()
    const target = snapshot.objects.find(object => object.id === payload.objectId)
    if (!target) throw new Error(`cannot delete unknown object: ${payload.objectId}`)
    const cleanupEvents: ControlInstanceEvent[] = snapshot.objects.flatMap(object => {
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
    const at = nowIso()
    if (command.kind !== deleteObjectCommandKind) {
      try {
        const events = await procedureCommandEvents({
          controlInstanceId: config.id,
          at,
          command,
          procedures: state.snapshot().procedures,
          factory: {
            eventId,
            nextSeq: () => ++seq,
          },
          readDocument: async (sourceId, procedureId) =>
            await procedureSourceService.readDocument({
              sourceId,
              procedureId,
            }),
        })
        if (events === null) return null
        await publishGenerated(() => events)
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
    try {
      const events = await publishGenerated(() => coreDeleteEvents(command, at))
      await config.runtimeConnection.observeCommittedEvents(events)
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
    const controlInstanceEvents = parsedEffects.map(effect => controlInstanceEventFromInteractionEffect(effect, at, provenance))
    await publishManyNow(controlInstanceEvents)
    await config.runtimeConnection.observeCommittedEvents(controlInstanceEvents)
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

  const publishPackRuntimeEmission = async (emission: PackRuntimeEmission): Promise<void> => {
    metrics.recordPackEmission(emission.runtimeId, emission.events.length, emission.emittedAt)
    await enqueuePublish(async () => {
      const pendingEvents: ControlInstanceEvent[] = []
      const pendingPersistences: ControlInstanceEventPersistenceDisposition[] = []

      const flushPendingEvents = async (): Promise<void> => {
        if (pendingEvents.length === 0) return
        const events = pendingEvents.splice(0, pendingEvents.length)
        const persistences = pendingPersistences.splice(0, pendingPersistences.length)
        await publishManyNow(events, {
          persistenceForEvent: (_event, _previousObject, index) => persistences[index],
        })
      }

      for (const event of emission.events) {
        if (event.type === 'interaction.signal') {
          await flushPendingEvents()
          await handleInteractionSignalNow(event.signal, event.provenance)
        } else {
          const persistence = persistenceForPackRuntimeEvent(event)
          pendingEvents.push(controlInstanceEventFromPackRuntimeEvent(event))
          pendingPersistences.push(persistence ?? 'projected')
        }
      }
      await flushPendingEvents()
    })
  }

  const publishPackRuntimeEmissionSafely = async (emission: PackRuntimeEmission): Promise<void> => {
    try {
      await publishPackRuntimeEmission(emission)
    } catch (err) {
      console.error(err)
    }
  }

  const unsubscribeRuntime = config.runtimeConnection.subscribe((emission) => {
    void publishPackRuntimeEmissionSafely(emission)
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
    const snapshot = await config.runtimeConnection.getSnapshot()
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
  if (hydratedClock) await config.runtimeConnection.setClock(hydratedClock)

  let scenarioRunner: ScenarioScriptRunner | null = null

  const issueCommandThroughRuntime = async (
    actor: Actor,
    command: CommandEnvelope,
    commandSource: Provenance['source'],
  ): Promise<CommandResult> => {
    if (command.controlInstanceId !== config.id) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: 'command control instance does not match active control instance' }
    }
    if (!canIssueCommand(actor, command)) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: `role ${actor.role} may not issue command ${command.kind}` }
    }
    const commandEventPersistence = config.runtimeConnection.commandEventPersistence?.(command) ?? 'durable'
    await publishOneGenerated(() => ({
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at: command.issuedAt,
      provenance: { source: commandSource },
      type: 'command.issued',
      command,
    }), { persistence: commandEventPersistence })
    const result = await handleCoreCommand(command) ?? await config.runtimeConnection.sendCommand(command)
    await publishQueue
    await publishOneGenerated(() => ({
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at: result.ok ? result.acceptedAt : result.rejectedAt,
      provenance: { source: 'simulator', causedByCommandId: command.id },
      type: 'command.result',
      result,
    }), { persistence: commandEventPersistence })
    return result
  }

  const commandEnvelopeForScenarioAction = (
    action: Extract<ScenarioScriptAction, { readonly type: 'issue_command' }>,
    at: IsoTimestamp,
  ): CommandEnvelope =>
    commandEnvelopeSchema.parse({
      id: `command:${randomUUID()}`,
      controlInstanceId: config.id,
      actorId: scenarioRunnerActor.id,
      kind: action.command.kind,
      targetObjectIds: action.command.targetObjectIds,
      payload: action.command.payload,
      issuedAt: at,
      ...(action.command.idempotencyKey === undefined ? {} : { idempotencyKey: action.command.idempotencyKey }),
      ...(action.command.expectedRevision === undefined ? {} : { expectedRevision: action.command.expectedRevision }),
    }) as CommandEnvelope

  const publishScenarioStep = async (step: ScenarioScriptStep, at: IsoTimestamp): Promise<void> => {
    const stepEvent = await publishOneGenerated(() => scenarioStepStartedEvent(step, at))
    await config.runtimeConnection.observeCommittedEvents([stepEvent])

    for (const action of step.actions) {
      if (action.type === 'emit_signal') {
        await enqueuePublish(async () => {
          await handleInteractionSignalNow(scenarioSignalForAction(action, at), { source: 'system' })
        })
        continue
      }
      if (action.type === 'issue_command') {
        const result = await issueCommandThroughRuntime(
          scenarioRunnerActor,
          commandEnvelopeForScenarioAction(action, at),
          'system',
        )
        if (!result.ok) throw new Error(result.reason)
        continue
      }
      const events = await publishGenerated(() => controlInstanceEventsForScenarioActions([action], at))
      if (events.length === 0) continue
      await config.runtimeConnection.observeCommittedEvents(events)
    }
  }

  const runDueScenarioSteps = async (): Promise<void> => {
    if (!config.scenario?.script || !state.snapshot().scenario?.script) return
    const dueSteps = dueScenarioScriptSteps({
      script: config.scenario.script,
      state: state.snapshot().scenario!,
      nowMs: currentClockMs(),
    })
    for (const step of dueSteps) {
      await publishScenarioStep(step, nowIso())
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
        await publishScenarioStep(step, nowIso())
      },
      onStepFailed: async (step, error): Promise<void> => {
        await publishOneGenerated(() => scenarioStepFailedEvent(step, error, nowIso()))
      },
    })
    scenarioRunner?.start()
  }

  if (config.scenario?.script && state.snapshot().scenario?.script) {
    await runDueScenarioSteps()
    startScenarioRunner()
  }

  const issueCommand = async (actor: Actor, command: CommandEnvelope): Promise<CommandResult> => {
    return await issueCommandThroughRuntime(actor, command, 'operator')
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
    await publishOneGenerated(() => ({
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at,
      provenance: { source: 'operator' },
      type: 'clock.updated',
      clock: nextClock,
    }))
    await config.runtimeConnection.setClock(nextClock)
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
    await config.runtimeConnection.query(request)

  const publishResetBoundary = async (resetConfig: { readonly scenarioId?: string }): Promise<ControlInstanceEvent> => {
    const snapshot = state.snapshot()
    const event = await publishOneGenerated(() => ({
      id: eventId(),
      controlInstanceId: config.id,
      seq: ++seq,
      at: nowIso(),
      provenance: { source: 'system' },
      type: 'controlInstance.reset',
      previousSeq: snapshot.seq,
      ...(snapshot.scenario?.scenarioId === undefined ? {} : { previousScenarioId: snapshot.scenario.scenarioId }),
      ...(resetConfig.scenarioId === undefined ? {} : { scenarioId: resetConfig.scenarioId }),
    }))
    return event
  }

  return {
    id: config.id,
    capabilities: (): ControlInstanceCapabilities => ({
      controlInstanceId: config.id,
      scenarioId: config.capabilities?.scenarioId ?? state.snapshot().scenario?.scenarioId ?? null,
      activePackIds: config.capabilities?.activePackIds ?? [],
      acceptedCommandKinds: config.capabilities?.acceptedCommandKinds ?? [],
      queryKinds: config.capabilities?.queryKinds ?? {},
      wikiRefs: config.capabilities?.wikiRefs ?? [],
    }),
    snapshot: () => snapshotWithCurrentClock(),
    setClock,
    events: (eventsConfig?: { readonly afterSeq?: number }): ReadonlyArray<ControlInstanceEvent> => {
      const afterSeq = eventsConfig?.afterSeq ?? -1
      return durableEvents.filter(event => event.seq > afterSeq)
    },
    subscribe: (handler: ControlInstanceEventHandler): (() => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    publishResetBoundary,
    issueCommand,
    queryPack,
    procedureSourceStatus: (statusConfig = {}) => procedureSourceService.readStatus(statusConfig),
    procedureCatalog: async (catalogConfig = {}) => await procedureSourceService.readCatalog(catalogConfig),
    procedureDocument: async (documentConfig) => await procedureSourceService.readDocument(documentConfig),
    publishInteractionSignal: async (signal: InteractionSignal, provenance: Provenance): Promise<void> => {
      await enqueuePublish(async () => {
        await handleInteractionSignalNow(signal, provenance)
      })
    },
    metrics: () => metrics.snapshot(),
    close: async (): Promise<void> => {
      scenarioRunner?.close()
      unsubscribeRuntime()
      await config.runtimeConnection.close()
      await publishQueue
      await flushProjectedSnapshot()
      metrics.markClosed(nowIso())
      handlers.clear()
    },
  }
}
