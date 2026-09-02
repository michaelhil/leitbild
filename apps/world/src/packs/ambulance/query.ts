import { z } from 'zod'
import type { IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { objectIdSchema, operationalObjectSchema } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { definePackQueryCapability } from '../../simulation/capabilities.ts'
import { ambulancePackDataSchema, ambulancePackId, hospitalPackDataSchema, incidentPackDataSchema } from './model.ts'

const objectQuerySchema = z.object({
  objectId: objectIdSchema,
})

const objectsQuerySchema = z.object({
  type: z.enum(['ambulance', 'hospital', 'incident']).optional(),
})

export const ambulanceQueryKinds = [
  'world.ambulance.objects',
  'world.ambulance.object',
  'world.ambulance.dispatch-state',
] as const

const ambulanceObjectTypeSchema = z.enum(['ambulance', 'hospital', 'incident'])
const ambulanceObjectsResultSchema = z.object({ objects: z.array(operationalObjectSchema) }).strict()
const ambulanceObjectResultSchema = z.object({
  object: operationalObjectSchema,
  type: ambulanceObjectTypeSchema.nullable(),
}).strict()
const ambulanceDispatchStateResultSchema = z.object({
  ambulances: z.array(z.object({
    object: operationalObjectSchema,
    targetObjectId: objectIdSchema.nullable(),
  }).strict()),
  incidents: z.array(z.object({
    object: operationalObjectSchema,
    assignedCapacity: z.number().finite().nonnegative(),
  }).strict()),
  hospitals: z.array(operationalObjectSchema),
}).strict()

export const ambulanceQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  definePackQueryCapability({
    id: ambulanceQueryKinds[0], title: 'List ambulance assets',
    description: 'Lists current ambulances, hospitals, and incidents, optionally filtered by asset type.',
    input: objectsQuerySchema, output: ambulanceObjectsResultSchema,
  }),
  definePackQueryCapability({
    id: ambulanceQueryKinds[1], title: 'Read ambulance asset',
    description: 'Reads one current Ambulance Pack Operational Object by its object id.',
    input: objectQuerySchema, output: ambulanceObjectResultSchema,
  }),
  definePackQueryCapability({
    id: ambulanceQueryKinds[2], title: 'Read dispatch state',
    description: 'Returns current ambulance assignments, incident coverage, and receiving hospitals.',
    input: z.object({}).strict(), output: ambulanceDispatchStateResultSchema,
  }),
]

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
  if (ambulancePackDataSchema.safeParse(object.packData).success) return 'ambulance'
  if (hospitalPackDataSchema.safeParse(object.packData).success) return 'hospital'
  if (incidentPackDataSchema.safeParse(object.packData).success) return 'incident'
  return null
}

const assignedCapacityFor = (
  incident: OperationalObject,
  objects: ReadonlyArray<OperationalObject>,
): number =>
  objects
    .filter(object => object.tasking?.currentTaskId === incident.id)
    .map(object => ambulancePackDataSchema.safeParse(object.packData))
    .filter((parsed): parsed is { readonly success: true; readonly data: z.infer<typeof ambulancePackDataSchema> } => parsed.success)
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
    const packObjects = config.objects.filter(object => object.packId === ambulancePackId)
    if (config.request.kind === ambulanceQueryKinds[0]) {
      const payload = objectsQuerySchema.parse(config.request.payload)
      const objects = payload.type
        ? packObjects.filter(object => ambulanceTypeOf(object) === payload.type)
        : packObjects
      return success(config.request, { objects }, config.at)
    }
    if (config.request.kind === ambulanceQueryKinds[1]) {
      const payload = objectQuerySchema.parse(config.request.payload)
      const object = packObjects.find(candidate => candidate.id === payload.objectId)
      if (!object) return failure(config.request, `ambulance pack object not found: ${payload.objectId}`, config.at)
      return success(config.request, { object, type: ambulanceTypeOf(object) }, config.at)
    }
    if (config.request.kind === ambulanceQueryKinds[2]) {
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
