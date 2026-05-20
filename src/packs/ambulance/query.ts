import { z } from 'zod'
import type { IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { objectIdSchema } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import { ambulanceDomainDataSchema, ambulanceDomainId, hospitalDomainDataSchema, incidentDomainDataSchema } from './model.ts'

const objectQuerySchema = z.object({
  objectId: objectIdSchema,
})

const objectsQuerySchema = z.object({
  type: z.enum(['ambulance', 'hospital', 'incident']).optional(),
})

const success = (request: PackQueryRequest, result: unknown, generatedAt: IsoTimestamp): PackQueryResponse => ({
  ok: true,
  packId: request.packId,
  kind: request.kind,
  result,
  generatedAt,
})

const failure = (request: PackQueryRequest, reason: string, generatedAt: IsoTimestamp): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt,
})

const ambulanceTypeOf = (object: OperationalObject): 'ambulance' | 'hospital' | 'incident' | null => {
  if (ambulanceDomainDataSchema.safeParse(object.domainData).success) return 'ambulance'
  if (hospitalDomainDataSchema.safeParse(object.domainData).success) return 'hospital'
  if (incidentDomainDataSchema.safeParse(object.domainData).success) return 'incident'
  return null
}

const assignedCapacityFor = (
  incident: OperationalObject,
  objects: ReadonlyArray<OperationalObject>,
): number =>
  objects
    .filter(object => object.tasking?.currentTaskId === incident.id)
    .map(object => ambulanceDomainDataSchema.safeParse(object.domainData))
    .filter((parsed): parsed is { readonly success: true; readonly data: z.infer<typeof ambulanceDomainDataSchema> } => parsed.success)
    .reduce((sum, parsed) => {
      const capacity = parsed.data.transport?.patientCapacity
      return sum + (capacity && capacity.state !== 'unknown' ? capacity.value : 0)
    }, 0)

export const answerAmbulanceQuery = (config: {
  readonly request: PackQueryRequest
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
}): PackQueryResponse => {
  try {
    const packObjects = config.objects.filter(object => object.domain === ambulanceDomainId)
    if (config.request.kind === 'ambulance.objects') {
      const payload = objectsQuerySchema.parse(config.request.payload)
      const objects = payload.type
        ? packObjects.filter(object => ambulanceTypeOf(object) === payload.type)
        : packObjects
      return success(config.request, { objects }, config.at)
    }
    if (config.request.kind === 'ambulance.object') {
      const payload = objectQuerySchema.parse(config.request.payload)
      const object = packObjects.find(candidate => candidate.id === payload.objectId)
      if (!object) return failure(config.request, `ambulance pack object not found: ${payload.objectId}`, config.at)
      return success(config.request, { object, type: ambulanceTypeOf(object) }, config.at)
    }
    if (config.request.kind === 'ambulance.dispatchState') {
      return success(config.request, {
        ambulances: packObjects
          .filter(object => ambulanceTypeOf(object) === 'ambulance')
          .map(object => ({
            object,
            targetObjectId: object.tasking?.currentTaskId ?? null,
          })),
        incidents: packObjects
          .filter(object => ambulanceTypeOf(object) === 'incident')
          .map(object => ({
            object,
            assignedCapacity: assignedCapacityFor(object, packObjects),
          })),
        hospitals: packObjects.filter(object => ambulanceTypeOf(object) === 'hospital'),
      }, config.at)
    }
    return failure(config.request, `ambulance pack does not support query kind: ${config.request.kind}`, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
