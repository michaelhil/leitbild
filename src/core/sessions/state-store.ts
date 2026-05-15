import type { DomainEvent, ObjectId, OperationalObject } from '../model/index.ts'

export interface SessionStateSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
}

export interface SessionStateStore {
  readonly apply: (event: DomainEvent) => void
  readonly snapshot: () => SessionStateSnapshot
  readonly getObject: (id: ObjectId) => OperationalObject | undefined
}

export const createSessionStateStore = (): SessionStateStore => {
  const objects = new Map<ObjectId, OperationalObject>()
  let seq = 0

  const apply = (event: DomainEvent): void => {
    seq = Math.max(seq, event.seq)
    if (event.type === 'object.upserted') {
      objects.set(event.object.id, event.object)
      return
    }
    if (event.type === 'object.deleted') {
      objects.delete(event.objectId)
      return
    }
    if (event.type === 'telemetry.sampled') {
      const current = objects.get(event.objectId)
      if (!current) {
        throw new Error(`telemetry event referenced unknown object: ${event.objectId}`)
      }
      objects.set(event.objectId, {
        ...current,
        telemetry: event.telemetry,
      })
    }
  }

  return {
    apply,
    snapshot: () => ({ objects: [...objects.values()], seq }),
    getObject: (id: ObjectId) => objects.get(id),
  }
}
