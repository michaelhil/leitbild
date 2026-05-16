import { z } from 'zod'
import { operationalObjectSchema, type DomainEvent, type ObjectId, type OperationalObject } from '../model/index.ts'

export interface ControlInstanceStateSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
}

export const controlInstanceStateSnapshotSchema = z.object({
  objects: z.array(operationalObjectSchema),
  seq: z.number().int().nonnegative(),
})

export interface ControlInstanceStateStore {
  readonly apply: (event: DomainEvent) => void
  readonly hydrate: (snapshot: ControlInstanceStateSnapshot) => void
  readonly snapshot: () => ControlInstanceStateSnapshot
  readonly getObject: (id: ObjectId) => OperationalObject | undefined
}

export const createControlInstanceStateStore = (): ControlInstanceStateStore => {
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

  const hydrate = (snapshot: ControlInstanceStateSnapshot): void => {
    objects.clear()
    for (const object of snapshot.objects) objects.set(object.id, object)
    seq = snapshot.seq
  }

  return {
    apply,
    hydrate,
    snapshot: () => ({ objects: [...objects.values()], seq }),
    getObject: (id: ObjectId) => objects.get(id),
  }
}
