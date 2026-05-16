import type { ObjectId, OperationalObject } from '../core/model/index.ts'

export interface ControlInstanceEventPayload {
  readonly type: string
  readonly object?: OperationalObject
  readonly objectId?: ObjectId
  readonly result?: {
    readonly ok: boolean
    readonly reason?: string
  }
}

export interface ControlInstanceEventBatchMessage {
  readonly type: 'events'
  readonly events: ReadonlyArray<ControlInstanceEventPayload>
}

interface ObjectApplicationResult {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly changed: boolean
  readonly routesChanged: boolean
}

export interface ObjectSelectionState {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
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
  readonly commandStatusUpdate?: CommandStatusUpdate
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

const parseEventPayload = (value: unknown): ControlInstanceEventPayload => {
  if (!isRecord(value)) throw new Error('invalid WebSocket event: expected object')
  if (typeof value.type !== 'string') throw new Error('invalid WebSocket event: missing event type')
  return {
    type: value.type,
    ...(isRecord(value.object) ? { object: value.object as unknown as OperationalObject } : {}),
    ...(typeof value.objectId === 'string' ? { objectId: value.objectId as ObjectId } : {}),
    ...(isCommandResult(value.result) ? { result: value.result } : {}),
  }
}

export const parseControlInstanceEventBatchMessage = (raw: string): ControlInstanceEventBatchMessage | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`invalid WebSocket JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(parsed) || parsed.type !== 'events') return null
  if (!Array.isArray(parsed.events)) throw new Error('invalid WebSocket events message: missing events array')

  return {
    type: 'events',
    events: parsed.events.map(parseEventPayload),
  }
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
  const commandResultEvent = [...message.events].reverse().find(event => event.type === 'command.result' && event.result)

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
    ...(commandResultEvent?.result
      ? {
          commandStatusUpdate: {
            commandStatus: commandStatusForResult(commandResultEvent.result),
          },
        }
      : {}),
  }
}
