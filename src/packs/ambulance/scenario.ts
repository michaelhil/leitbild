import { z } from 'zod'
import {
  confirmedFact,
  estimatedFact,
  geoPointFromLonLat,
  objectIdSchema,
  type ActorId,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import type { AmbulanceDomainData, IncidentDomainData } from './model.ts'
import {
  createScenarioAmbulanceObject,
  createScenarioHospitalObject,
  createScenarioIncidentObject,
} from './sim/object-state.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const victimCountSchema = z.union([
  z.object({
    state: z.literal('unknown'),
  }),
  z.object({
    state: z.enum(['estimated', 'confirmed']).default('estimated'),
    count: z.number().int().nonnegative(),
  }),
])

const hospitalSpecSchema = z.object({
  pack: z.literal('ambulance'),
  type: z.literal('hospital'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema,
  traumaBeds: z.object({
    total: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
  }),
})

const ambulanceSpecSchema = z.object({
  pack: z.literal('ambulance'),
  type: z.literal('ambulance'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema.optional(),
  atObject: objectIdSchema.optional(),
  equipment: z.array(z.string().min(1)).default([]),
  patientsOnBoard: z.number().int().nonnegative().optional(),
  targetId: objectIdSchema.optional(),
  status: z.string().min(1).optional(),
})

const incidentSpecSchema = z.object({
  pack: z.literal('ambulance'),
  type: z.literal('incident'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema,
  triage: z.enum(['green', 'yellow', 'red']),
  victims: victimCountSchema.default({ state: 'unknown' }),
  status: z.enum(['open', 'assigned', 'responding', 'resolved']).optional(),
})

const setIncidentVictimsOperationSchema = z.object({
  pack: z.literal('ambulance'),
  type: z.literal('set_incident_victims'),
  victims: victimCountSchema,
})

const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

const pointForAmbulance = (
  spec: z.infer<typeof ambulanceSpecSchema>,
  objectById: (id: ObjectId) => OperationalObject | undefined,
): GeoJsonPoint => {
  if (spec.position) return pointFromLonLat(spec.position)
  if (!spec.atObject) throw new Error(`ambulance scenario object ${spec.id} requires position or atObject`)
  const object = objectById(spec.atObject)
  const point = object?.spatial.position?.point
  if (!point) throw new Error(`ambulance scenario object ${spec.id} references object without position: ${spec.atObject}`)
  return point
}

const withAmbulanceState = (
  object: OperationalObject,
  spec: z.infer<typeof ambulanceSpecSchema>,
  at: IsoTimestamp,
): OperationalObject => {
  if (spec.patientsOnBoard === undefined && spec.targetId === undefined && spec.status === undefined) return object
  const data = object.domainData as AmbulanceDomainData
  return {
    ...object,
    revision: object.revision + 1,
    operational: {
      ...object.operational,
      status: spec.status ?? object.operational.status,
      ...(spec.targetId === undefined ? {} : { intent: 'transport_patient' }),
    },
    ...(spec.targetId === undefined
      ? {}
      : {
          tasking: {
            currentTaskId: spec.targetId,
            assignedBy: 'actor:dispatcher' as ActorId,
            assignedAt: at,
          },
        }),
    domainData: {
      ...data,
      transport: {
        ...data.transport!,
        patientsOnBoard: confirmedFact(spec.patientsOnBoard ?? 0, at, 'scenario', 1),
      },
    } satisfies AmbulanceDomainData,
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
  }
}

const incidentVictimCount = (
  victims: z.infer<typeof victimCountSchema>,
  at: IsoTimestamp,
) =>
  victims.state === 'unknown'
    ? undefined
    : victims.count

const withIncidentStatus = (
  object: OperationalObject,
  status: z.infer<typeof incidentSpecSchema>['status'],
  at: IsoTimestamp,
): OperationalObject =>
  status === undefined
    ? object
    : {
        ...object,
        revision: object.revision + 1,
        lifecycle: status === 'resolved' ? 'resolved' : object.lifecycle,
        operational: {
          ...object.operational,
          status,
        },
        timestamps: {
          ...object.timestamps,
          updatedAt: at,
        },
      }

const withVictimCount = (
  object: OperationalObject,
  victims: z.infer<typeof victimCountSchema>,
  at: IsoTimestamp,
): OperationalObject => {
  const data = object.domainData as IncidentDomainData
  return {
    ...object,
    revision: object.revision + 1,
    domainData: {
      ...data,
      victims: {
        ...data.victims,
        count: victims.state === 'unknown'
          ? data.victims.count.state === 'unknown'
            ? data.victims.count
            : { state: 'unknown' as const, updatedAt: at, source: 'scenario' as const }
          : victims.state === 'confirmed'
            ? confirmedFact(victims.count, at, 'scenario', 1)
            : estimatedFact(victims.count, at, 'scenario', 0.84),
      },
    } satisfies IncidentDomainData,
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
  }
}

export const ambulanceScenarioSupport: PackScenarioSupport = {
  expandObject: (rawSpec, context): OperationalObject => {
    if (rawSpec.type === 'hospital') {
      const spec = hospitalSpecSchema.parse(rawSpec)
      return createScenarioHospitalObject({
        id: spec.id,
        label: spec.label,
        point: pointFromLonLat(spec.position),
        traumaBedsTotal: spec.traumaBeds.total,
        traumaBedsAvailable: spec.traumaBeds.available,
        at: context.at,
      })
    }
    if (rawSpec.type === 'ambulance') {
      const spec = ambulanceSpecSchema.parse(rawSpec)
      return withAmbulanceState(createScenarioAmbulanceObject({
        id: spec.id,
        label: spec.label,
        point: pointForAmbulance(spec, context.objectById),
        equipment: spec.equipment,
        at: context.at,
      }), spec, context.at)
    }
    if (rawSpec.type === 'incident') {
      const spec = incidentSpecSchema.parse(rawSpec)
      const object = createScenarioIncidentObject({
        id: spec.id,
        label: spec.label,
        point: pointFromLonLat(spec.position),
        triage: spec.triage,
        victimCount: incidentVictimCount(spec.victims, context.at) ?? 'unknown',
        at: context.at,
      })
      return withIncidentStatus(object, spec.status, context.at)
    }
    throw new Error(`unsupported ambulance scenario object type: ${rawSpec.type}`)
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec, context): OperationalObject => {
    if (rawOperation.type === 'set_incident_victims') {
      const operation = setIncidentVictimsOperationSchema.parse(rawOperation)
      if (context.object.kind !== 'incident') {
        throw new Error(`set_incident_victims requires incident object: ${context.object.id}`)
      }
      return withVictimCount(context.object, operation.victims, context.at)
    }
    throw new Error(`unsupported ambulance scenario operation type: ${rawOperation.type}`)
  },
}
