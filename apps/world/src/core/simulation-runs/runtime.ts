import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, SimulationRunEvent, EventId, SimulationRunId, InteractionEffect, InteractionHandler, InteractionSignal, IsoTimestamp, ObjectId, OperationalObject, ProcedureCatalog, ProcedureDocument, ProcedureId, ProcedureSourceId, Provenance, RecordedSample, RecordingProfileDescriptor, RecordingSeriesDescriptor, RecordingSeriesQuery, ScenarioExecutionState, ScenarioRecordingSelection, ScenarioTimeline, ScenarioTimelineAction, ScenarioTimelineCue, SimulationClockState, SimulationClockUpdate } from '../model/index.ts'
import { actorIdSchema, commandEnvelopeSchema, deleteObjectCommandKind, deleteObjectPayloadSchema, interactionEffectSchema, interactionSignalSchema, notificationIdSchema, nowIso, simulationClockUpdateSchema } from '../model/index.ts'
import type { PackWikiRef } from '../packs/protocol.ts'
import type { SimulationCapability, PackRuntimeConnection, PackRuntimeEmission, PackRuntimeEvent, PackRuntimeHealth, PackRuntimeRealtimeInput, PackRuntimeRealtimeMessage } from '../../simulation/protocol.ts'
import type { EventLog } from './event-log.ts'
import { createSimulationRunStateStore, type SimulationRunStateSnapshot } from './state-store.ts'
import type { SimulationRunSnapshotStore } from './snapshot-store.ts'
import { canIssueCommand, type Actor } from './actors.ts'
import { persistenceDispositionFor, type SimulationRunEventPersistenceDisposition } from './persistence-policy.ts'
import { createScenarioTimelineRunner, dueScenarioTimelineCues, type ScenarioTimelineRunner } from './timeline-runner.ts'
import {
  createSimulationRunRuntimeMetricsRecorder,
  type SimulationRunRuntimeMetricsSnapshot,
} from './runtime-metrics.ts'
import { defaultSimulationRunRuntimePolicy } from './runtime-persistence-policy.ts'
import { createProcedureSourceService, type ProcedureSourceLoadStatus, type ProcedureSourceService } from '../../features/procedures/source.ts'
import { procedureCommandEvents } from '../../features/procedures/run-state.ts'
import type { WorkspaceId } from '@leitbild/contracts'
import type { ScenarioRevisionId } from '../scenarios/library.ts'
import type { RunHistorian, RunHistorianStatus } from '../../features/historian/store.ts'
import {
  CommandIdempotencyConflictError,
  commandIdempotencyConfigFromEnv,
  createCommandIdempotencyStore,
  issueCommandWithIdempotency,
} from './command-idempotency.ts'

const projectedSnapshotFlushIntervalMs = defaultSimulationRunRuntimePolicy.projectedSnapshotFlushIntervalMs
const scenarioRunnerActor: Actor = {
  id: actorIdSchema.parse('actor:scenario-timeline'),
  label: 'Scenario timeline',
  role: 'system',
}

interface PublishManyOptions {
  readonly history?: SimulationRunEventPersistenceDisposition
  readonly historyForEvent?: (
    event: SimulationRunEvent,
    previousObject: OperationalObject | undefined,
    index: number,
  ) => SimulationRunEventPersistenceDisposition | undefined
}

export interface SimulationRunEventNotification {
  readonly type: 'event.notification'
  readonly events: ReadonlyArray<SimulationRunEvent>
  readonly realtimeMessages?: ReadonlyArray<PackRuntimeRealtimeMessage>
}

export type SimulationRunEventHandler = (event: SimulationRunEventNotification) => void

export interface SimulationRunRuntime {
  readonly id: SimulationRunId
  readonly capabilities: () => SimulationRunCapabilities
  readonly snapshot: () => SimulationRunStateSnapshot
  readonly setClock: (update: SimulationClockUpdate) => Promise<SimulationClockState>
  readonly events: (config?: { readonly afterSeq?: number }) => ReadonlyArray<SimulationRunEvent>
  readonly subscribe: (handler: SimulationRunEventHandler) => () => void
  readonly publishResetBoundary: (config: { readonly scenarioId?: string }) => Promise<SimulationRunEvent>
  readonly invokeCapability: (actor: Actor, invocation: SimulationRunCapabilityInvocation) => Promise<SimulationRunCapabilityInvocationResult>
  readonly receiveRealtimeInput: (input: PackRuntimeRealtimeInput) => Promise<void>
  readonly procedureSourceStatus: (config?: { readonly sourceId?: ProcedureSourceId }) => ProcedureSourceLoadStatus
  readonly procedureCatalog: (config?: { readonly sourceId?: ProcedureSourceId; readonly refresh?: boolean }) => Promise<ProcedureCatalog>
  readonly procedureDocument: (config: { readonly sourceId?: ProcedureSourceId; readonly procedureId: ProcedureId; readonly refresh?: boolean }) => Promise<ProcedureDocument>
  readonly publishInteractionSignal: (signal: InteractionSignal, provenance: Provenance) => Promise<void>
  readonly metrics: () => SimulationRunRuntimeMetricsSnapshot
  readonly health: () => ReadonlyArray<PackRuntimeHealth>
  readonly recordingStatus: () => RunHistorianStatus | null
  readonly recordingSeries: () => ReadonlyArray<RecordingSeriesDescriptor & { readonly runtimeId: string }>
  readonly recordedSamples: (query: RecordingSeriesQuery) => ReadonlyArray<RecordedSample>
  readonly close: () => Promise<void>
}

export interface SimulationRunCapabilityInvocation {
  readonly capabilityId: string
  readonly input: unknown
  readonly expectedRevision?: number
  readonly idempotencyKey?: string
  readonly scheduled?: boolean
  readonly issuedAt?: IsoTimestamp
}

export type SimulationRunCapabilityInvocationResult =
  | { readonly kind: 'query'; readonly result: unknown }
  | { readonly kind: 'command'; readonly result: CommandResult; readonly replayed: boolean }

export interface ActiveSimulationCapability {
  readonly packId: string
  readonly runtimeId: string
  readonly capability: SimulationCapability
}

export interface SimulationRunCapabilities {
  readonly workspaceId: WorkspaceId | null
  readonly simulationRunId: SimulationRunId
  readonly scenarioId: string | null
  readonly scenarioRevisionId: ScenarioRevisionId | null
  readonly activePackIds: ReadonlyArray<string>
  readonly runtimes: ReadonlyArray<{
    readonly id: string
    readonly packId: string
    readonly clock: 'simulation' | 'live' | 'none'
  }>
  readonly capabilities: ReadonlyArray<{
    readonly id: string
    readonly kind: 'command' | 'query'
    readonly title: string
    readonly description: string
    readonly risk: 'read' | 'write' | 'destructive'
    readonly idempotent: boolean
    readonly schedulable?: boolean
    readonly inputSchema: Readonly<Record<string, unknown>>
    readonly outputSchema: Readonly<Record<string, unknown>>
    readonly packId: string
    readonly runtimeId: string
  }>
  readonly wikiRefs: ReadonlyArray<PackWikiRef>
  readonly recording: {
    readonly selections: ReadonlyArray<ScenarioRecordingSelection>
    readonly profiles: ReadonlyArray<RecordingProfileDescriptor & {
      readonly packId: string
      readonly runtimeId: string
    }>
  }
}

const eventId = (): EventId => `event:${randomUUID()}` as EventId

export const createSimulationRunRuntime = async (config: {
  readonly id: SimulationRunId
  readonly runtimeConnection: PackRuntimeConnection
  readonly eventLog: EventLog
  readonly snapshotStore: SimulationRunSnapshotStore
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
  readonly restoredSnapshot?: SimulationRunStateSnapshot
  readonly restoredEvents?: ReadonlyArray<SimulationRunEvent>
  readonly initialSeq?: number
  readonly scenario: {
    readonly id: string
    readonly startsAt: IsoTimestamp
    readonly timeline?: ScenarioTimeline
  }
  readonly capabilities?: Omit<SimulationRunCapabilities, 'simulationRunId'>
  readonly runtimeCapabilities?: ReadonlyArray<ActiveSimulationCapability>
  readonly procedureSourceService?: ProcedureSourceService
  readonly historian?: RunHistorian
}): Promise<SimulationRunRuntime> => {
  const state = createSimulationRunStateStore()
  const metrics = createSimulationRunRuntimeMetricsRecorder({
    simulationRunId: config.id,
    createdAt: nowIso(),
  })
  const handlers = new Set<SimulationRunEventHandler>()
  const durableEvents: SimulationRunEvent[] = [...(config.restoredEvents ?? [])]
  const restoredEventSeq = durableEvents.reduce((max, event) => Math.max(max, event.seq), 0)
  let seq = Math.max(config.initialSeq ?? 0, config.restoredSnapshot?.seq ?? 0, restoredEventSeq)
  let publishQueue: Promise<void> = Promise.resolve()
  let snapshotSaveQueue: Promise<void> = Promise.resolve()
  let projectedSnapshotDirty = false
  let projectedSnapshotTimer: ReturnType<typeof setTimeout> | null = null
  const interactionHandlers = [...(config.interactionHandlers ?? [])]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
  const procedureSourceService = config.procedureSourceService ?? createProcedureSourceService()
  const commandIdempotencyStore = createCommandIdempotencyStore()
  const commandIdempotency = commandIdempotencyConfigFromEnv()
  const runtimeCapabilities = new Map<string, ActiveSimulationCapability>()
  for (const entry of config.runtimeCapabilities ?? []) {
    if (runtimeCapabilities.has(entry.capability.id)) {
      throw new Error(`duplicate active Simulation Capability: ${entry.capability.id}`)
    }
    runtimeCapabilities.set(entry.capability.id, entry)
  }

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

  const snapshotWithCurrentClock = (): SimulationRunStateSnapshot => {
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
    if (!Number.isFinite(currentTimeMs)) throw new Error(`invalid simulation run clock time: ${clock.currentTime}`)
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
          console.error('simulation run projected snapshot save failed:', err)
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
    simulationRunEvents: ReadonlyArray<SimulationRunEvent>,
    options?: PublishManyOptions,
  ): Promise<void> => {
    if (simulationRunEvents.length === 0) return
    const eventsToPersist: SimulationRunEvent[] = []
    let projectedEventCount = 0
    for (const [index, event] of simulationRunEvents.entries()) {
      const previousObject = event.type === 'object.upserted' ? state.getObject(event.object.id) : undefined
      state.apply(event)
      const persistence = options?.history
        ?? options?.historyForEvent?.(event, previousObject, index)
        ?? persistenceDispositionFor(event, previousObject)
      if (persistence === 'durable') {
        durableEvents.push(event)
        eventsToPersist.push(event)
      } else {
        projectedEventCount += 1
      }
    }
    metrics.recordPublishedEvents({
      eventCount: simulationRunEvents.length,
      durableEventCount: eventsToPersist.length,
      projectedEventCount,
    })
    await config.eventLog.appendMany(eventsToPersist)
    if (eventsToPersist.length > 0) {
      await saveSnapshotImmediately()
    } else {
      scheduleProjectedSnapshotSave()
    }
    const notification: SimulationRunEventNotification = { type: 'event.notification', events: simulationRunEvents }
    for (const handler of handlers) handler(notification)
    await config.runtimeConnection.observeCommittedEvents(simulationRunEvents)
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
    generate: () => ReadonlyArray<SimulationRunEvent> | Promise<ReadonlyArray<SimulationRunEvent>>,
    options?: PublishManyOptions,
  ): Promise<ReadonlyArray<SimulationRunEvent>> => {
    let generatedEvents: ReadonlyArray<SimulationRunEvent> = []
    await enqueuePublish(async () => {
      generatedEvents = await generate()
      await publishManyNow(generatedEvents, options)
    })
    return generatedEvents
  }

  const publishOneGenerated = async (
    generate: () => SimulationRunEvent | Promise<SimulationRunEvent>,
    options?: PublishManyOptions,
  ): Promise<SimulationRunEvent> => {
    const events = await publishGenerated(async () => [await generate()], options)
    const event = events[0]
    if (!event) throw new Error('internal event generation produced no event')
    return event
  }

  const nextScenarioBase = (at: IsoTimestamp): Omit<SimulationRunEvent, 'type'> => ({
    id: eventId(),
    simulationRunId: config.id,
    seq: ++seq,
    at,
    provenance: { source: 'system' },
  })

  const simulationRunEventFromScenarioAction = (
    action: ScenarioTimelineAction,
    at: IsoTimestamp,
  ): SimulationRunEvent | null => {
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
    if (action.type === 'emit_signal' || action.type === 'invoke_capability') return null
    return { ...nextScenarioBase(at), type: 'object.deleted', objectId: action.objectId }
  }

  const scenarioSignalForAction = (
    action: Extract<ScenarioTimelineAction, { readonly type: 'emit_signal' }>,
    at: IsoTimestamp,
  ): InteractionSignal => ({
    id: action.signal.id,
    simulationRunId: config.id,
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

  const scenarioCueStartedEvent = (cue: ScenarioTimelineCue, at: IsoTimestamp): SimulationRunEvent => ({
    ...nextScenarioBase(at),
    type: 'scenario.cue.started',
    cueId: cue.id,
  })

  const scenarioCueFailedEvent = (cue: ScenarioTimelineCue, error: unknown, at: IsoTimestamp): SimulationRunEvent => ({
    ...nextScenarioBase(at),
    type: 'notification.emitted',
    notification: {
      id: notificationIdSchema.parse(`notification:scenario-cue-failed:${cue.id}:${randomUUID()}`),
      simulationRunId: config.id,
      at,
      title: 'Scenario cue failed',
      message: `Scenario cue ${cue.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'critical',
      source: { kind: 'simulation', id: 'scenario-timeline' },
      targets: [{ kind: 'broadcast' }],
    },
  })

  const simulationRunEventsForScenarioActions = (actions: ReadonlyArray<ScenarioTimelineAction>, at: IsoTimestamp): ReadonlyArray<SimulationRunEvent> =>
    actions
      .map(action => simulationRunEventFromScenarioAction(action, at))
      .filter((event): event is SimulationRunEvent => event !== null)

  const nextBase = (simEvent: PackRuntimeEvent): Omit<SimulationRunEvent, 'type'> => ({
    id: eventId(),
    simulationRunId: config.id,
    seq: ++seq,
    at: simEvent.at,
    provenance: simEvent.provenance,
  })

  const simulationRunEventFromPackRuntimeEvent = (simEvent: PackRuntimeEvent): SimulationRunEvent => {
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

  const simulationRunEventFromInteractionEffect = (
    effect: InteractionEffect,
    at: IsoTimestamp,
    provenance: Provenance,
  ): SimulationRunEvent => {
    if (effect.type === 'object.upsert') {
      return {
        id: eventId(),
        simulationRunId: config.id,
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
        simulationRunId: config.id,
        seq: ++seq,
        at,
        provenance,
        type: 'object.deleted',
        objectId: effect.objectId,
      }
    }
    return {
      id: eventId(),
      simulationRunId: config.id,
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

  const coreDeleteEvents = (command: CommandEnvelope, at: IsoTimestamp): ReadonlyArray<SimulationRunEvent> => {
    const payload = deleteObjectPayloadSchema.parse(command.payload)
    const snapshot = state.snapshot()
    const target = snapshot.objects.find(object => object.id === payload.objectId)
    if (!target) throw new Error(`cannot delete unknown object: ${payload.objectId}`)
    const cleanupEvents: SimulationRunEvent[] = snapshot.objects.flatMap(object => {
      const cleaned = clearDeletedObjectReference(object, payload.objectId, at, command)
      return cleaned
        ? [{
            id: eventId(),
            simulationRunId: config.id,
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
        simulationRunId: config.id,
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
          simulationRunId: config.id,
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
      await publishGenerated(() => coreDeleteEvents(command, at))
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
    const simulationRunEvents = parsedEffects.map(effect => simulationRunEventFromInteractionEffect(effect, at, provenance))
    await publishManyNow(simulationRunEvents)
  }

  const handleInteractionSignalNow = async (
    signal: InteractionSignal,
    provenance: Provenance,
  ): Promise<void> => {
    const parsedSignal = interactionSignalSchema.parse(signal) as InteractionSignal
    if (parsedSignal.simulationRunId !== config.id) {
      throw new Error(`interaction signal simulation run mismatch: ${parsedSignal.simulationRunId}`)
    }
    await publishManyNow([{
      id: eventId(),
      simulationRunId: config.id,
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
    if (emission.recording !== undefined) {
      if (!config.historian) throw new Error(`Pack Runtime ${emission.runtimeId} emitted recording samples without an active Run Historian`)
      config.historian.record(emission.runtimeId, emission.recording)
    }
    await enqueuePublish(async () => {
      const pendingEvents: SimulationRunEvent[] = []
      const pendingPersistences: SimulationRunEventPersistenceDisposition[] = []

      const flushPendingEvents = async (): Promise<void> => {
        if (pendingEvents.length === 0) return
        const events = pendingEvents.splice(0, pendingEvents.length)
        const persistences = pendingPersistences.splice(0, pendingPersistences.length)
        await publishManyNow(events, {
          historyForEvent: (_event, _previousObject, index) => persistences[index],
        })
      }

      for (const event of emission.events) {
        if (event.type === 'interaction.signal') {
          await flushPendingEvents()
          await handleInteractionSignalNow(event.signal, event.provenance)
        } else {
          pendingEvents.push(simulationRunEventFromPackRuntimeEvent(event))
          pendingPersistences.push(event.history === 'record' ? 'durable' : 'projected')
        }
      }
      await flushPendingEvents()
      if (emission.realtimeMessages && emission.realtimeMessages.length > 0) {
        const notification: SimulationRunEventNotification = {
          type: 'event.notification',
          events: [],
          realtimeMessages: emission.realtimeMessages,
        }
        for (const handler of handlers) handler(notification)
      }
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

  const initialScenarioState = (): ScenarioExecutionState => ({
    scenarioId: config.scenario.id,
    highlightedObjectIds: [],
    ...(config.scenario.timeline === undefined
      ? {}
      : {
          timeline: {
            startedAt: config.scenario.startsAt,
            firedCueIds: [],
          },
        }),
  })

  if (config.restoredSnapshot) {
    state.hydrate({
      ...config.restoredSnapshot,
      clock: config.restoredSnapshot.clock ?? {
        currentTime: config.scenario.startsAt,
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
        currentTime: config.scenario.startsAt,
        updatedAt: nowIso(),
        paused: false,
        speed: 1,
      },
      scenario: scenarioState,
    })
    await config.snapshotStore.save(snapshotWithCurrentClock())
  }
  const hydratedClock = state.snapshot().clock
  if (hydratedClock) await config.runtimeConnection.setClock(hydratedClock)

  let scenarioRunner: ScenarioTimelineRunner | null = null

  const issueCommandThroughRuntime = async (
    actor: Actor,
    command: CommandEnvelope,
    commandSource: Provenance['source'],
  ): Promise<CommandResult> => {
    if (command.simulationRunId !== config.id) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: 'command simulation run does not match active simulation run' }
    }
    if (!canIssueCommand(actor, command)) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: `role ${actor.role} may not issue command ${command.kind}` }
    }
    const commandEventHistory = config.runtimeConnection.commandEventHistory?.(command) ?? 'record'
    const commandEventDisposition = commandEventHistory === 'record' ? 'durable' : 'projected'
    await publishOneGenerated(() => ({
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at: command.issuedAt,
      provenance: { source: commandSource },
      type: 'command.issued',
      command,
    }), { history: commandEventDisposition })
    const result = await handleCoreCommand(command) ?? await config.runtimeConnection.sendCommand(command)
    await publishQueue
    await publishOneGenerated(() => ({
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at: result.ok ? result.acceptedAt : result.rejectedAt,
      provenance: { source: 'simulator', causedByCommandId: command.id },
      type: 'command.result',
      result,
    }), { history: commandEventDisposition })
    return result
  }

  const invokeCapabilityThroughRuntime = async (
    actor: Actor,
    invocation: SimulationRunCapabilityInvocation,
    commandSource: Provenance['source'],
  ): Promise<SimulationRunCapabilityInvocationResult> => {
    const active = runtimeCapabilities.get(invocation.capabilityId)
    if (!active) throw new Error(`Simulation Capability is not active: ${invocation.capabilityId}`)
    if (invocation.scheduled === true && active.capability.schedulable !== true) {
      throw new Error(`Simulation Capability is not schedulable: ${invocation.capabilityId}`)
    }
    const input = active.capability.input.parse(invocation.input)
    if (active.capability.kind === 'query') {
      const result = await config.runtimeConnection.invokeQuery({
        capabilityId: active.capability.id,
        input,
      })
      return { kind: 'query', result: active.capability.output.parse(result) }
    }
    const built = active.capability.buildCommand?.(input)
    if (!built) throw new Error(`Simulation command Capability cannot build a command: ${active.capability.id}`)
    const command = commandEnvelopeSchema.parse({
      id: `command:${randomUUID()}`,
      simulationRunId: config.id,
      actorId: actor.id,
      kind: active.capability.id,
      targetObjectIds: built.targetObjectIds,
      payload: built.payload,
      issuedAt: invocation.issuedAt ?? nowIso(),
      ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
      ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
    }) as CommandEnvelope
    const issued = await issueCommandWithIdempotency({
      store: commandIdempotencyStore,
      idempotency: commandIdempotency,
      actor,
      command,
      issue: async (commandActor, commandToIssue) =>
        await issueCommandThroughRuntime(commandActor, commandToIssue, commandSource),
    })
    if (!issued.ok) throw new CommandIdempotencyConflictError(issued.message)
    return {
      kind: 'command',
      result: active.capability.output.parse(issued.result) as CommandResult,
      replayed: issued.replayed,
    }
  }

  const publishScenarioCue = async (cue: ScenarioTimelineCue, at: IsoTimestamp): Promise<void> => {
    await publishOneGenerated(() => scenarioCueStartedEvent(cue, at))

    for (const action of cue.actions) {
      if (action.type === 'emit_signal') {
        await enqueuePublish(async () => {
          await handleInteractionSignalNow(scenarioSignalForAction(action, at), { source: 'system' })
        })
        continue
      }
      if (action.type === 'invoke_capability') {
        const outcome = await invokeCapabilityThroughRuntime(scenarioRunnerActor, {
          capabilityId: action.capabilityId,
          input: action.input,
          scheduled: true,
          issuedAt: at,
        }, 'system')
        if (outcome.kind !== 'command') throw new Error(`Scenario cannot invoke query Capability: ${action.capabilityId}`)
        if (!outcome.result.ok) throw new Error(outcome.result.reason)
        continue
      }
      await publishGenerated(() => simulationRunEventsForScenarioActions([action], at))
    }
  }

  const runDueScenarioCues = async (): Promise<void> => {
    if (!config.scenario.timeline || !state.snapshot().scenario?.timeline) return
    const dueCues = dueScenarioTimelineCues({
      timeline: config.scenario.timeline,
      state: state.snapshot().scenario!,
      nowMs: currentClockMs(),
    })
    for (const cue of dueCues) {
      await publishScenarioCue(cue, nowIso())
    }
  }

  const startScenarioRunner = (): void => {
    scenarioRunner?.close()
    scenarioRunner = null
    const clock = state.snapshot().clock
    if (clock?.paused) return
    const runnerScenarioState = state.snapshot().scenario
    if (!config.scenario.timeline || !runnerScenarioState?.timeline) return
    scenarioRunner = createScenarioTimelineRunner({
      timeline: config.scenario.timeline,
      state: runnerScenarioState,
      nowMs: currentClockMs,
      delayMs: (dueAtMs, nowMs): number => {
        const speed = state.snapshot().clock?.speed ?? 1
        return Math.max(0, (dueAtMs - nowMs) / speed)
      },
      onCueDue: async (cue): Promise<void> => {
        await publishScenarioCue(cue, nowIso())
      },
      onCueFailed: async (cue, error): Promise<void> => {
        await publishOneGenerated(() => scenarioCueFailedEvent(cue, error, nowIso()))
      },
    })
    scenarioRunner?.start()
  }

  if (config.scenario.timeline && state.snapshot().scenario?.timeline) {
    await runDueScenarioCues()
    startScenarioRunner()
  }

  const receiveRealtimeInput = async (input: PackRuntimeRealtimeInput): Promise<void> => {
    if (!config.runtimeConnection.receiveRealtimeInput) throw new Error(`runtime cannot receive realtime input type: ${input.type}`)
    await config.runtimeConnection.receiveRealtimeInput(input)
  }

  const setClock = async (update: SimulationClockUpdate): Promise<SimulationClockState> => {
    const parsedUpdate = simulationClockUpdateSchema.parse(update) as SimulationClockUpdate
    const currentClock = state.snapshot().clock
    if (!currentClock) throw new Error('simulation run clock is not initialized')
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
      simulationRunId: config.id,
      seq: ++seq,
      at,
      provenance: { source: 'operator' },
      type: 'clock.updated',
      clock: nextClock,
    }))
    await config.runtimeConnection.setClock(nextClock)
    if (config.scenario.timeline) {
      if (nextClock.paused) {
        scenarioRunner?.close()
        scenarioRunner = null
      } else {
        await runDueScenarioCues()
        startScenarioRunner()
      }
    }
    return nextClock
  }

  const invokeCapability = async (
    actor: Actor,
    invocation: SimulationRunCapabilityInvocation,
  ): Promise<SimulationRunCapabilityInvocationResult> =>
    await invokeCapabilityThroughRuntime(actor, invocation, 'operator')

  const publishResetBoundary = async (resetConfig: { readonly scenarioId?: string }): Promise<SimulationRunEvent> => {
    const snapshot = state.snapshot()
    const event = await publishOneGenerated(() => ({
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at: nowIso(),
      provenance: { source: 'system' },
      type: 'simulationRun.reset',
      previousSeq: snapshot.seq,
      ...(snapshot.scenario?.scenarioId === undefined ? {} : { previousScenarioId: snapshot.scenario.scenarioId }),
      ...(resetConfig.scenarioId === undefined ? {} : { scenarioId: resetConfig.scenarioId }),
    }))
    return event
  }

  return {
    id: config.id,
    capabilities: (): SimulationRunCapabilities => ({
      workspaceId: config.capabilities?.workspaceId ?? null,
      simulationRunId: config.id,
      scenarioId: config.capabilities?.scenarioId ?? config.scenario.id,
      scenarioRevisionId: config.capabilities?.scenarioRevisionId ?? null,
      activePackIds: config.capabilities?.activePackIds ?? [],
      runtimes: config.capabilities?.runtimes ?? [],
      capabilities: config.capabilities?.capabilities ?? [],
      wikiRefs: config.capabilities?.wikiRefs ?? [],
      recording: config.capabilities?.recording ?? { selections: [], profiles: [] },
    }),
    snapshot: () => snapshotWithCurrentClock(),
    setClock,
    events: (eventsConfig?: { readonly afterSeq?: number }): ReadonlyArray<SimulationRunEvent> => {
      const afterSeq = eventsConfig?.afterSeq ?? -1
      return durableEvents.filter(event => event.seq > afterSeq)
    },
    subscribe: (handler: SimulationRunEventHandler): (() => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    publishResetBoundary,
    invokeCapability,
    receiveRealtimeInput,
    procedureSourceStatus: (statusConfig = {}) => procedureSourceService.readStatus(statusConfig),
    procedureCatalog: async (catalogConfig = {}) => await procedureSourceService.readCatalog(catalogConfig),
    procedureDocument: async (documentConfig) => await procedureSourceService.readDocument(documentConfig),
    publishInteractionSignal: async (signal: InteractionSignal, provenance: Provenance): Promise<void> => {
      await enqueuePublish(async () => {
        await handleInteractionSignalNow(signal, provenance)
      })
    },
    metrics: () => metrics.snapshot(),
    health: () => config.runtimeConnection.health?.() ?? [],
    recordingStatus: () => config.historian?.status() ?? null,
    recordingSeries: () => config.historian?.listSeries() ?? [],
    recordedSamples: (query) => config.historian?.query(query) ?? [],
    close: async (): Promise<void> => {
      scenarioRunner?.close()
      unsubscribeRuntime()
      await config.runtimeConnection.close()
      await publishQueue
      await flushProjectedSnapshot()
      config.historian?.close()
      metrics.markClosed(nowIso())
      handlers.clear()
    },
  }
}
