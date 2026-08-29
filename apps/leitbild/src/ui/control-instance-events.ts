import type { CommandResult, ControlInstanceId, IsoTimestamp, ObjectId, OperationalNotification, OperationalObject, ScenarioGuidance, ScenarioInstanceState, SimulationClockState } from '../core/model/index.ts'
import type { PackRuntimeRealtimeMessage } from '../simulation/protocol.ts'

export interface ControlInstanceEventPayload {
  readonly type: string
  readonly at?: IsoTimestamp
  readonly object?: OperationalObject
  readonly objectId?: ObjectId
  readonly stepId?: string
  readonly guidance?: ScenarioGuidance
  readonly guidanceId?: string
  readonly notification?: OperationalNotification
  readonly objectIds?: ReadonlyArray<ObjectId>
  readonly result?: {
    readonly ok: boolean
    readonly reason?: string
  }
  readonly clock?: SimulationClockState
}

export interface ControlInstanceEventBatchMessage {
  readonly type: 'events'
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly events: ReadonlyArray<ControlInstanceEventPayload>
}

export interface RealtimeReadyMessage {
  readonly type: 'realtime.ready'
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly clock?: SimulationClockState
}

export interface RealtimeCommandResultMessage {
  readonly type: 'command.result'
  readonly controlInstanceId: ControlInstanceId
  readonly requestId: string
  readonly result: CommandResult
}

export interface RealtimeCommandErrorMessage {
  readonly type: 'command.error'
  readonly controlInstanceId: ControlInstanceId
  readonly requestId?: string
  readonly message: string
}

export interface RuntimeRealtimeMessageBatch {
  readonly type: 'runtime.realtime'
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly messages: ReadonlyArray<PackRuntimeRealtimeMessage>
}

export interface RuntimeInputErrorMessage {
  readonly type: 'runtime.input.error'
  readonly controlInstanceId: ControlInstanceId
  readonly inputType?: string
  readonly message: string
}

export type ControlInstanceWebSocketMessage =
  | ControlInstanceEventBatchMessage
  | RealtimeReadyMessage
  | RealtimeCommandResultMessage
  | RealtimeCommandErrorMessage
  | RuntimeRealtimeMessageBatch
  | RuntimeInputErrorMessage

interface ObjectApplicationResult {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly changed: boolean
  readonly routesChanged: boolean
}

export interface ObjectSelectionState {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly scenarioState?: ScenarioInstanceState
}

export interface ObjectSelectionUpdate {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
}

export interface CommandStatusUpdate {
  readonly commandStatus: string
}

export interface ControlInstanceEventApplication {
  readonly objectUpdate?: ObjectSelectionUpdate
  readonly scenarioUpdate?: ScenarioInstanceState
  readonly commandStatusUpdate?: CommandStatusUpdate
  readonly clockUpdate?: SimulationClockState
  readonly routesChanged: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isCommandResult = (
  value: unknown,
): value is { readonly ok: boolean; readonly reason?: string } => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  return value.reason === undefined || typeof value.reason === 'string'
}

const isRealtimeCommandResult = (value: unknown): value is CommandResult => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (typeof value.commandId !== 'string') return false
  if (value.ok) return typeof value.acceptedAt === 'string'
  return typeof value.rejectedAt === 'string' && typeof value.reason === 'string'
}

const parseEventPayload = (value: unknown): ControlInstanceEventPayload => {
  if (!isRecord(value)) throw new Error('invalid WebSocket event: expected object')
  if (typeof value.type !== 'string') throw new Error('invalid WebSocket event: missing event type')
  return {
    type: value.type,
    ...(typeof value.at === 'string' ? { at: value.at as IsoTimestamp } : {}),
    ...(isRecord(value.object) ? { object: value.object as unknown as OperationalObject } : {}),
    ...(typeof value.objectId === 'string' ? { objectId: value.objectId as ObjectId } : {}),
    ...(typeof value.stepId === 'string' ? { stepId: value.stepId } : {}),
    ...(isRecord(value.guidance) ? { guidance: value.guidance as unknown as ScenarioGuidance } : {}),
    ...(typeof value.guidanceId === 'string' ? { guidanceId: value.guidanceId } : {}),
    ...(isRecord(value.notification) ? { notification: value.notification as unknown as OperationalNotification } : {}),
    ...(Array.isArray(value.objectIds) ? { objectIds: value.objectIds.filter((objectId): objectId is ObjectId => typeof objectId === 'string') } : {}),
    ...(isCommandResult(value.result) ? { result: value.result } : {}),
    ...(isRecord(value.clock) ? { clock: value.clock as unknown as SimulationClockState } : {}),
  }
}

const parseRealtimeMessage = (value: unknown): PackRuntimeRealtimeMessage => {
  if (!isRecord(value)) throw new Error('invalid runtime realtime message: expected object')
  if (typeof value.type !== 'string' || value.type.trim().length === 0) throw new Error('invalid runtime realtime message: missing type')
  if (typeof value.at !== 'string') throw new Error('invalid runtime realtime message: missing timestamp')
  return {
    type: value.type,
    at: value.at as IsoTimestamp,
    payload: value.payload,
  }
}

export const parseControlInstanceWebSocketMessage = (raw: string): ControlInstanceWebSocketMessage | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`invalid WebSocket JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(parsed)) return null
  if (parsed.type === 'realtime.ready') {
    if (typeof parsed.controlInstanceId !== 'string') throw new Error('invalid realtime ready message: missing control instance id')
    if (typeof parsed.snapshotSeq !== 'number') throw new Error('invalid realtime ready message: missing snapshot sequence')
    return {
      type: 'realtime.ready',
      controlInstanceId: parsed.controlInstanceId as ControlInstanceId,
      ...(typeof parsed.scenarioId === 'string' ? { scenarioId: parsed.scenarioId } : {}),
      snapshotSeq: parsed.snapshotSeq,
      ...(isRecord(parsed.clock) ? { clock: parsed.clock as unknown as SimulationClockState } : {}),
    }
  }
  if (parsed.type === 'command.result') {
    if (typeof parsed.controlInstanceId !== 'string') throw new Error('invalid command result message: missing control instance id')
    if (typeof parsed.requestId !== 'string') throw new Error('invalid command result message: missing request id')
    if (!isRealtimeCommandResult(parsed.result)) throw new Error('invalid command result message: invalid command result')
    return {
      type: 'command.result',
      controlInstanceId: parsed.controlInstanceId as ControlInstanceId,
      requestId: parsed.requestId,
      result: parsed.result,
    }
  }
  if (parsed.type === 'command.error') {
    if (typeof parsed.controlInstanceId !== 'string') throw new Error('invalid command error message: missing control instance id')
    if (typeof parsed.message !== 'string') throw new Error('invalid command error message: missing message')
    return {
      type: 'command.error',
      controlInstanceId: parsed.controlInstanceId as ControlInstanceId,
      ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
      message: parsed.message,
    }
  }
  if (parsed.type === 'runtime.realtime') {
    if (typeof parsed.controlInstanceId !== 'string') throw new Error('invalid runtime realtime message batch: missing control instance id')
    if (typeof parsed.snapshotSeq !== 'number') throw new Error('invalid runtime realtime message batch: missing snapshot sequence')
    if (!Array.isArray(parsed.messages)) throw new Error('invalid runtime realtime message batch: missing messages array')
    return {
      type: 'runtime.realtime',
      controlInstanceId: parsed.controlInstanceId as ControlInstanceId,
      ...(typeof parsed.scenarioId === 'string' ? { scenarioId: parsed.scenarioId } : {}),
      snapshotSeq: parsed.snapshotSeq,
      messages: parsed.messages.map(parseRealtimeMessage),
    }
  }
  if (parsed.type === 'runtime.input.error') {
    if (typeof parsed.controlInstanceId !== 'string') throw new Error('invalid runtime input error message: missing control instance id')
    if (typeof parsed.message !== 'string') throw new Error('invalid runtime input error message: missing message')
    return {
      type: 'runtime.input.error',
      controlInstanceId: parsed.controlInstanceId as ControlInstanceId,
      ...(typeof parsed.inputType === 'string' ? { inputType: parsed.inputType } : {}),
      message: parsed.message,
    }
  }
  if (parsed.type !== 'events') return null
  if (typeof parsed.controlInstanceId !== 'string') throw new Error('invalid WebSocket events message: missing control instance id')
  if (typeof parsed.snapshotSeq !== 'number') throw new Error('invalid WebSocket events message: missing snapshot sequence')
  if (!Array.isArray(parsed.events)) throw new Error('invalid WebSocket events message: missing events array')

  return {
    type: 'events',
    controlInstanceId: parsed.controlInstanceId as ControlInstanceId,
    ...(typeof parsed.scenarioId === 'string' ? { scenarioId: parsed.scenarioId } : {}),
    snapshotSeq: parsed.snapshotSeq,
    events: parsed.events.map(parseEventPayload),
  }
}

export const parseControlInstanceEventBatchMessage = (raw: string): ControlInstanceEventBatchMessage | null => {
  const message = parseControlInstanceWebSocketMessage(raw)
  return message?.type === 'events' ? message : null
}

const applyScenarioEvents = (
  scenarioState: ScenarioInstanceState | undefined,
  events: ReadonlyArray<ControlInstanceEventPayload>,
): ScenarioInstanceState | undefined => {
  let nextState = scenarioState
  for (const event of events) {
    const current = nextState
    if (!current) continue
    if (event.type === 'scenario.step.started' && event.stepId) {
      if (!current.script) continue
      nextState = {
        ...current,
        script: {
          startedAt: current.script.startedAt,
          firedStepIds: [...new Set([...current.script.firedStepIds, event.stepId])],
        },
      }
    }
    if (event.type === 'scenario.guidance.shown' && event.guidance) {
      nextState = { ...current, guidance: event.guidance }
    }
    if (event.type === 'scenario.guidance.hidden') {
      if (event.guidanceId === undefined || current.guidance?.id === event.guidanceId) {
        const { guidance: _guidance, ...withoutGuidance } = current
        nextState = withoutGuidance
      }
    }
    if (event.type === 'notification.emitted' && event.notification) {
      nextState = {
        ...current,
        guidance: {
          id: event.notification.id,
          title: event.notification.title,
          message: event.notification.message,
          objectIds: event.notification.targets.flatMap(target => target.kind === 'object' ? [target.id] : []),
          dismissible: true,
          tone: 'update',
        },
      }
    }
    if (event.type === 'scenario.objects.highlighted' && event.objectIds) {
      nextState = { ...current, highlightedObjectIds: [...event.objectIds] }
    }
    if (event.type === 'scenario.highlights.cleared') {
      nextState = {
        ...current,
        highlightedObjectIds: event.objectIds === undefined
          ? []
          : current.highlightedObjectIds.filter(objectId => !event.objectIds?.includes(objectId)),
      }
    }
  }
  return nextState === scenarioState ? undefined : nextState
}

export const upsertOperationalObject = (
  objects: ReadonlyArray<OperationalObject>,
  object: OperationalObject,
): ReadonlyArray<OperationalObject> => {
  const existingIndex = objects.findIndex(existing => existing.id === object.id)
  if (existingIndex === -1) return [...objects, object]
  return objects.map((existing, index) => index === existingIndex ? object : existing)
}

export const removeOperationalObject = (
  state: ObjectSelectionState,
  objectId: string,
): ObjectSelectionUpdate => ({
  objects: state.objects.filter(object => object.id !== objectId),
  selectedControllerId: state.selectedControllerId === objectId ? null : state.selectedControllerId,
})

export const commandStatusForResult = (
  result: { readonly ok: boolean; readonly reason?: string },
): string =>
  result.ok ? 'Command accepted' : `Command rejected: ${result.reason ?? 'unknown reason'}`

const applyObjectEvents = (
  state: ObjectSelectionState,
  events: ReadonlyArray<ControlInstanceEventPayload>,
): ObjectApplicationResult => {
  const objectsById = new Map<ObjectId, OperationalObject>()
  const order: ObjectId[] = []
  for (const object of state.objects) {
    objectsById.set(object.id, object)
    order.push(object.id)
  }

  let selectedControllerId = state.selectedControllerId
  let changed = false
  let routesChanged = false
  for (const event of events) {
    if (event.type === 'object.upserted' && event.object) {
      const existingObject = objectsById.get(event.object.id)
      routesChanged = routesChanged || routeStateKey(existingObject) !== routeStateKey(event.object)
      if (!objectsById.has(event.object.id)) order.push(event.object.id)
      objectsById.set(event.object.id, event.object)
      changed = true
    }
    if (event.type === 'object.deleted' && event.objectId) {
      routesChanged = routesChanged || routeStateKey(objectsById.get(event.objectId)) !== ''
      if (objectsById.delete(event.objectId)) changed = true
      if (selectedControllerId === event.objectId) selectedControllerId = null
    }
  }

  return {
    objects: order.flatMap(objectId => {
      const object = objectsById.get(objectId)
      return object ? [object] : []
    }),
    selectedControllerId,
    changed,
    routesChanged,
  }
}

const routeStateKey = (object: OperationalObject | undefined): string => {
  const route = object?.spatial.route?.planned
  if (!object || !route) return ''
  return [
    object.tasking?.currentTaskId ?? '',
    object.spatial.position?.point.coordinates.join(',') ?? '',
    object.spatial.route?.etaSeconds ?? '',
    object.spatial.route?.progress?.segmentIndex ?? '',
    object.spatial.route?.progress?.remainingDistanceM ?? '',
    object.spatial.route?.source ?? '',
    route.coordinates.map(coordinate => `${coordinate[0]},${coordinate[1]}`).join(';'),
  ].join('|')
}

export const applyControlInstanceEventBatchMessage = (
  state: ObjectSelectionState,
  message: ControlInstanceEventBatchMessage,
): ControlInstanceEventApplication => {
  const objectResult = applyObjectEvents(state, message.events)
  const scenarioUpdate = applyScenarioEvents(state.scenarioState, message.events)
  const commandResultEvent = [...message.events].reverse().find(event => event.type === 'command.result' && event.result)
  const clockEvent = [...message.events].reverse().find(event => event.type === 'clock.updated' && event.clock)

  return {
    routesChanged: objectResult.routesChanged,
    ...(objectResult.changed || objectResult.selectedControllerId !== state.selectedControllerId
      ? {
          objectUpdate: {
            objects: objectResult.objects,
            selectedControllerId: objectResult.selectedControllerId,
          },
        }
      : {}),
    ...(scenarioUpdate === undefined ? {} : { scenarioUpdate }),
    ...(commandResultEvent?.result
      ? {
          commandStatusUpdate: {
            commandStatus: commandStatusForResult(commandResultEvent.result),
          },
        }
      : {}),
    ...(clockEvent?.clock ? { clockUpdate: clockEvent.clock } : {}),
  }
}
