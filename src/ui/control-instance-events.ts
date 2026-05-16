import type { ObjectId, OperationalObject } from '../core/model/index.ts'

export interface ControlInstanceEventMessage {
  readonly type: 'event'
  readonly event: {
    readonly type: string
    readonly object?: OperationalObject
    readonly objectId?: ObjectId
    readonly result?: {
      readonly ok: boolean
      readonly reason?: string
    }
  }
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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isCommandResult = (
  value: unknown,
): value is { readonly ok: boolean; readonly reason?: string } => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  return value.reason === undefined || typeof value.reason === 'string'
}

export const parseControlInstanceEventMessage = (raw: string): ControlInstanceEventMessage | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`invalid WebSocket JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(parsed) || parsed.type !== 'event' || !isRecord(parsed.event)) return null

  const event = parsed.event
  if (typeof event.type !== 'string') throw new Error('invalid WebSocket event: missing event type')

  return {
    type: 'event',
    event: {
      type: event.type,
      ...(isRecord(event.object) ? { object: event.object as unknown as OperationalObject } : {}),
      ...(typeof event.objectId === 'string' ? { objectId: event.objectId as ObjectId } : {}),
      ...(isCommandResult(event.result) ? { result: event.result } : {}),
    },
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

export const applyControlInstanceEventMessage = (
  state: ObjectSelectionState,
  message: ControlInstanceEventMessage,
): ControlInstanceEventApplication => {
  if (message.event.type === 'object.upserted' && message.event.object) {
    return {
      objectUpdate: {
        objects: upsertOperationalObject(state.objects, message.event.object),
        selectedControllerId: state.selectedControllerId,
      },
    }
  }

  if (message.event.type === 'object.deleted' && message.event.objectId) {
    return {
      objectUpdate: removeOperationalObject(state, message.event.objectId),
    }
  }

  if (message.event.type === 'command.result' && message.event.result) {
    return {
      commandStatusUpdate: {
        commandStatus: commandStatusForResult(message.event.result),
      },
    }
  }

  return {}
}
