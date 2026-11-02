import type { OperationalObject } from '../../core/model/index.ts'
import type { QueryReadPolicy } from '../../simulation/query-read-policy.ts'
import { ambulanceDataOf } from './model.ts'

/** Exact typed references in the canonical Ambulance object, including retained observations. */
export const ambulanceInspectionReferences = (object: OperationalObject): ReadonlyArray<string> => {
  const data = ambulanceDataOf(object)
  switch (data.type) {
    case 'response-unit': return [...data.assignment?.patientIds ?? [], ...data.assignment?.stops.flatMap(stop => [...stop.patientIds, ...(stop.kind === 'return-base' ? [] : [stop.targetId])]) ?? []]
    case 'patient': return [data.incidentId, data.holder.id]
    case 'incident': return [...data.subjectObjectId === undefined ? [] : [data.subjectObjectId], ...data.observations.flatMap(observation => [observation.observerId, ...observation.casualties.map(casualty => casualty.patientId)])]
    case 'care-site': return data.subjectObjectId === undefined ? [] : [data.subjectObjectId]
  }
}

/** Preserve visible units/incidents while omitting private related records.
 * Canonical state is not changed. A raw-object read uses reference closure instead. */
export const ambulanceQueryObjects = (objects: ReadonlyArray<OperationalObject>, policy: QueryReadPolicy): ReadonlyArray<OperationalObject> => {
  if (!policy.restricted) return objects
  return objects.filter(object => policy.canInspect(object.id)).flatMap(object => {
    if (object.packId !== 'ambulance') return [object]
    const data = ambulanceDataOf(object)
    if (data.type === 'patient' && (!policy.canInspect(data.incidentId) || !policy.canInspect(data.holder.id))) return []
    if (data.type === 'incident') return [{ ...object, packData: { ...data,
      subjectObjectId: data.subjectObjectId !== undefined && policy.canInspect(data.subjectObjectId) ? data.subjectObjectId : undefined,
      observations: data.observations.filter(observation => policy.canInspect(observation.observerId) && observation.casualties.every(casualty => policy.canInspect(casualty.patientId))),
    } }]
    if (data.type === 'care-site' && data.subjectObjectId !== undefined && !policy.canInspect(data.subjectObjectId)) return [{ ...object, packData: { ...data, subjectObjectId: undefined } }]
    return [object]
  })
}
