import type { GeoJsonPoint, KnowledgeFact, OperationalObject } from '../../core/model/index.ts'
import type { LeitbildPack, PackCommandRequest, PackObjectPresentation } from '../../core/packs/protocol.ts'
import {
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
  type CreatableAmbulanceObjectType,
} from './commands.ts'
import {
  ambulanceDomainDataSchema,
  ambulanceDomainId,
  hospitalDomainDataSchema,
  incidentDomainDataSchema,
  type AmbulanceDomainData,
  type HospitalDomainData,
  type IncidentDomainData,
  type InjurySummary,
} from './model.ts'

const factText = <T>(fact: KnowledgeFact<T> | undefined, formatter: (value: T) => string = String): string =>
  !fact || fact.state === 'unknown' ? 'unknown' : formatter(fact.value)

const listText = (values: readonly string[]): string =>
  values.length === 0 ? 'none' : values.map(value => value.replaceAll('_', ' ')).join(', ')

const injuryText = (injuries: readonly InjurySummary[]): string =>
  injuries.length === 0
    ? 'none reported'
    : injuries.map(injury => `${injury.count} ${injury.severity} ${injury.category}`).join(', ')

const targetLabel = (object: OperationalObject, objects: ReadonlyArray<OperationalObject>): string =>
  object.tasking?.currentTaskId
    ? objects.find(candidate => candidate.id === object.tasking?.currentTaskId)?.label ?? object.tasking.currentTaskId
    : 'idle'

const parseAmbulanceData = (object: OperationalObject): AmbulanceDomainData | null => {
  const parsed = ambulanceDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const parseIncidentData = (object: OperationalObject): IncidentDomainData | null => {
  const parsed = incidentDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const parseHospitalData = (object: OperationalObject): HospitalDomainData | null => {
  const parsed = hospitalDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const ambulanceDetails = (
  object: OperationalObject,
  data: AmbulanceDomainData,
  objects: ReadonlyArray<OperationalObject>,
): ReadonlyArray<string> => [
  `Destination: ${targetLabel(object, objects)}`,
  `Capabilities: ${listText(data.capabilities)}`,
  `Crew: ${factText(data.crew.level)}`,
  `Seats: ${factText(data.crew.availableSeats)}`,
  `Patients: ${factText(data.transport?.patientsOnBoard, String)} / ${factText(data.transport?.patientCapacity, String)}`,
]

const incidentDetails = (data: IncidentDomainData): ReadonlyArray<string> => [
  `Triage: ${factText(data.triage)}`,
  `Victims: ${factText(data.victims.count, String)}`,
  `Injuries: ${factText(data.victims.injuries, injuryText)}`,
  `Hazards: ${factText(data.hazards, listText)}`,
]

const hospitalDetails = (data: HospitalDomainData): ReadonlyArray<string> => [
  `Trauma beds: ${factText(data.emergencyDepartment.traumaBedsAvailable, String)}`,
  `Ambulance bays: ${factText(data.emergencyDepartment.ambulanceBaysAvailable, String)}`,
  `Patients received: ${factText(data.emergencyDepartment.patientsReceived, String)}`,
  `Diversion: ${factText(data.emergencyDepartment.diversionStatus)}`,
  `Capabilities: ${listText(data.capabilities)}`,
]

const presentationForAmbulance = (
  object: OperationalObject,
  objects: ReadonlyArray<OperationalObject>,
): PackObjectPresentation => {
  const data = parseAmbulanceData(object)
  return {
    categoryId: 'ambulances',
    icon: 'ambulance',
    color: '#22845d',
    summary: `${object.tasking?.currentTaskId ? `Target: ${targetLabel(object, objects)}` : 'Target: none'} · ${object.operational.status}`,
    detailLines: data ? ambulanceDetails(object, data, objects) : ['Invalid ambulance domain data'],
  }
}

const presentationForIncident = (object: OperationalObject): PackObjectPresentation => {
  const data = parseIncidentData(object)
  return {
    categoryId: 'incidents',
    icon: 'crash',
    color: '#c7352b',
    summary: data ? `victims ${factText(data.victims.count, String)} · triage ${factText(data.triage)}` : object.operational.status,
    detailLines: data ? incidentDetails(data) : ['Invalid incident domain data'],
  }
}

const presentationForHospital = (object: OperationalObject): PackObjectPresentation => {
  const data = parseHospitalData(object)
  return {
    categoryId: 'hospitals',
    icon: 'hospital',
    color: '#245b9f',
    summary: data
      ? `ER ${factText(data.emergencyDepartment.diversionStatus)} · bays ${factText(data.emergencyDepartment.ambulanceBaysAvailable, String)}`
      : object.operational.status,
    detailLines: data ? hospitalDetails(data) : ['Invalid hospital domain data'],
  }
}

const countForCategory = (
  objects: ReadonlyArray<OperationalObject>,
  categoryId: string,
): number =>
  objects.filter(object => ambulancePack.categories.find(category => category.id === categoryId)?.matches(object)).length

const assertCreatableType = (typeId: string): CreatableAmbulanceObjectType => {
  if (typeId === 'ambulance' || typeId === 'hospital' || typeId === 'incident') return typeId
  throw new Error(`unsupported ambulance pack create type: ${typeId}`)
}

export const ambulancePack: LeitbildPack = {
  id: 'ambulance',
  name: 'Ambulance Dispatch',
  domain: ambulanceDomainId,
  categories: [
    {
      id: 'hospitals',
      label: 'Hospitals',
      emptyLabel: 'No hospitals',
      matches: (object: OperationalObject): boolean => parseHospitalData(object) !== null,
    },
    {
      id: 'ambulances',
      label: 'Ambulances',
      emptyLabel: 'No ambulances',
      matches: (object: OperationalObject): boolean => parseAmbulanceData(object) !== null,
    },
    {
      id: 'incidents',
      label: 'Incidents',
      emptyLabel: 'No incidents',
      matches: (object: OperationalObject): boolean => parseIncidentData(object) !== null,
    },
  ],
  createObjectTypes: [
    { id: 'hospital', label: 'Hospital', categoryId: 'hospitals', icon: 'hospital', color: '#245b9f' },
    { id: 'ambulance', label: 'Ambulance', categoryId: 'ambulances', icon: 'ambulance', color: '#22845d' },
    { id: 'incident', label: 'Incident', categoryId: 'incidents', icon: 'crash', color: '#c7352b' },
  ],
  presentObject: (object, context): PackObjectPresentation => {
    if (parseAmbulanceData(object)) return presentationForAmbulance(object, context.objects)
    if (parseHospitalData(object)) return presentationForHospital(object)
    if (parseIncidentData(object)) return presentationForIncident(object)
    return {
      categoryId: 'unknown',
      icon: 'unknown',
      color: '#667085',
      summary: object.operational.status,
      detailLines: ['Object is outside the ambulance pack vocabulary'],
    }
  },
  defaultObjectLabel: (typeId, context): string => {
    const type = assertCreatableType(typeId)
    const definition = ambulancePack.createObjectTypes.find(candidate => candidate.id === type)
    if (!definition) throw new Error(`missing create type definition: ${type}`)
    const index = countForCategory(context.objects, definition.categoryId) + 1
    return `${definition.label} ${index}`
  },
  buildCreateObjectCommand: (typeId, label, point: GeoJsonPoint): PackCommandRequest => ({
    kind: createObjectCommandKind,
    targetObjectIds: [],
    payload: {
      objectType: assertCreatableType(typeId),
      label,
      point,
    },
  }),
  isController: (object): boolean => parseAmbulanceData(object) !== null,
  isTarget: (_controller, candidate): boolean =>
    parseIncidentData(candidate) !== null || parseHospitalData(candidate) !== null,
  buildSetTargetCommand: (controller, target): PackCommandRequest => ({
    kind: setDestinationCommandKind,
    targetObjectIds: [controller.id, target.id],
    payload: {
      ambulanceId: controller.id,
      destinationId: target.id,
    },
  }),
  buildCancelTargetCommand: (controller): PackCommandRequest => ({
    kind: cancelDestinationCommandKind,
    targetObjectIds: [controller.id],
    payload: {
      ambulanceId: controller.id,
    },
  }),
}
