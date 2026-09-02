import { z } from 'zod'
import type { IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { objectIdSchema, operationalObjectSchema } from '../../core/model/index.ts'
import type { PackRuntimeQuery, SimulationCapability } from '../../simulation/protocol.ts'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import { ambulancePackDataSchema, ambulancePackId, hospitalPackDataSchema, incidentPackDataSchema } from './model.ts'

const objectQuerySchema = z.object({
  objectId: objectIdSchema,
}).strict()

const objectsQuerySchema = z.object({
  type: z.enum(['ambulance', 'hospital', 'incident']).optional(),
}).strict()

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
  defineSimulationQueryCapability({
    id: ambulanceQueryKinds[0], title: 'List ambulance assets',
    description: 'Lists current ambulances, hospitals, and incidents, optionally filtered by asset type.',
    input: objectsQuerySchema, output: ambulanceObjectsResultSchema,
  }),
  defineSimulationQueryCapability({
    id: ambulanceQueryKinds[1], title: 'Read ambulance asset',
    description: 'Reads one current Ambulance Pack Operational Object by its object id.',
    input: objectQuerySchema, output: ambulanceObjectResultSchema,
  }),
  defineSimulationQueryCapability({
    id: ambulanceQueryKinds[2], title: 'Read dispatch state',
    description: 'Returns current ambulance assignments, incident coverage, and receiving hospitals.',
    input: z.object({}).strict(), output: ambulanceDispatchStateResultSchema,
  }),
]

const failure = (reason: string): never => { throw new Error(reason) }

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
  readonly request: PackRuntimeQuery
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at: IsoTimestamp
}): unknown => {
  try {
    const packObjects = config.objects.filter(object => object.packId === ambulancePackId)
    if (config.request.capabilityId === ambulanceQueryKinds[0]) {
      const payload = objectsQuerySchema.parse(config.request.input)
      const objects = payload.type
        ? packObjects.filter(object => ambulanceTypeOf(object) === payload.type)
        : packObjects
      return { objects }
    }
    if (config.request.capabilityId === ambulanceQueryKinds[1]) {
      const payload = objectQuerySchema.parse(config.request.input)
      const object = packObjects.find(candidate => candidate.id === payload.objectId)
      if (!object) return failure(`ambulance pack object not found: ${payload.objectId}`)
      return { object, type: ambulanceTypeOf(object) }
    }
    if (config.request.capabilityId === ambulanceQueryKinds[2]) {
      return {
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
      }
    }
    return failure(`ambulance Pack does not support query Capability: ${config.request.capabilityId}`)
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err))
  }
}
