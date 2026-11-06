import type { OperationalObject } from '../model/index.ts'
import type { WorldPack } from './protocol.ts'
import { createQueryReadPolicy, type QueryReadPolicy } from '../../simulation/query-read-policy.ts'
import { refObjectId } from '../model/alerts.ts'

/** Typed references owned by World itself, plus those in the Pack's data. */
export const objectInspectionReferences = (object: OperationalObject, owner: WorldPack): ReadonlyArray<string> => [
  ...owner.inspectionReferences(object),
  ...(object.tasking?.currentTaskId === undefined ? [] : [object.tasking.currentTaskId]),
  ...(object.spatial.route?.impacts ?? []).flatMap(impact => impact.source.kind === 'object' ? [impact.source.id] : []),
  ...object.alerts.flatMap(alert => alert.observable === undefined ? [] : [refObjectId(alert.observable)]),
  ...(object.context?.references ?? []).flatMap(reference => reference.kind === 'object' || reference.kind === 'task' ? [reference.id] : []),
  ...(object.context?.facts ?? []).flatMap(fact => [...fact.relatedObjectIds, ...fact.relatedTaskIds]),
  ...(object.context?.activity ?? []).flatMap(activity => [...activity.relatedObjectIds, ...activity.relatedTaskIds]),
]

/** Raw canonical objects cannot omit fields without changing their meaning.
 * Close owner-declared references before exposing such an object. Separate
 * Pack query projections may retain safe fields and omit denied relations. */
export const rawObjectReadPolicy = (policy: QueryReadPolicy, objects: ReadonlyArray<OperationalObject>, packs: ReadonlyArray<WorldPack>): QueryReadPolicy => {
  if (!policy.restricted) return policy
  const owners = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  const denied = new Set(objects.filter(object => !policy.canInspect(object.id)).map(object => String(object.id)))
  const dependents = new Map<string, string[]>()
  const pending = [...denied]
  for (const object of objects) {
    const owner = owners.get(object.packId)
    if (!owner) throw new Error(`No inspection owner for Pack ${object.packId}`)
    for (const reference of objectInspectionReferences(object, owner)) {
      const list = dependents.get(reference) ?? []
      list.push(object.id)
      dependents.set(reference, list)
      // Restrictions may name a deleted object not present in this snapshot.
      if (!policy.canInspect(reference) && !denied.has(reference)) { denied.add(reference); pending.push(reference) }
    }
  }
  for (let at = 0; at < pending.length; at++) {
    for (const id of dependents.get(pending[at]!) ?? []) {
      if (denied.has(id)) continue
      denied.add(id)
      pending.push(id)
    }
  }
  return createQueryReadPolicy(policy.key, [...denied])
}
