import type { KnowledgeFact, OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../../core/packs/protocol.ts'
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
import { osloAmbulanceTutorialScenario } from './scenario.ts'
import { createAmbulanceArrivalInteractionHandler } from './sim/interactions.ts'

const factText = <T>(fact: KnowledgeFact<T> | undefined, formatter: (value: T) => string = String): string =>
  !fact || fact.state === 'unknown' ? 'unknown' : formatter(fact.value)

const knownNumber = (fact: KnowledgeFact<number> | undefined): number | null =>
  fact && fact.state !== 'unknown' ? fact.value : null

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

const formatDurationMmSs = (seconds: number): string => {
  const boundedSeconds = Math.max(0, Math.ceil(seconds))
  const minutes = Math.floor(boundedSeconds / 60)
  const remainingSeconds = boundedSeconds % 60
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

const formatArrivalClock = (seconds: number, now: Date = new Date()): string =>
  new Date(now.getTime() + Math.max(0, Math.ceil(seconds)) * 1000)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const etaText = (object: OperationalObject): string | null =>
  object.spatial.route?.etaSeconds === undefined
    ? null
    : `ETA: ${formatDurationMmSs(object.spatial.route.etaSeconds)} · Arrives ${formatArrivalClock(object.spatial.route.etaSeconds)}`

const routeImpactText = (object: OperationalObject): string | null => {
  const impacts = object.spatial.route?.impacts ?? []
  if (impacts.length === 0) return null
  return `Traffic impact: ${impacts.map(impact => `${impact.label} (${impact.severity})`).join(', ')}`
}

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
): ReadonlyArray<PackObjectField> => [
  packField('destination', 'Destination', targetLabel(object, objects)),
  ...(etaText(object) ? [packField('eta', 'ETA', etaText(object)!.replace(/^ETA: /, ''))] : []),
  ...(routeImpactText(object) ? [packField('traffic-impact', 'Traffic impact', routeImpactText(object)!.replace(/^Traffic impact: /, ''))] : []),
  packField('capabilities', 'Capabilities', listText(data.capabilities)),
  packField('crew', 'Crew', factText(data.crew.level)),
  packField('seats', 'Seats', factText(data.crew.availableSeats)),
  packField('patients', 'Patients', `${factText(data.transport?.patientsOnBoard, String)} / ${factText(data.transport?.patientCapacity, String)}`),
]

const ambulanceCapacity = (object: OperationalObject): number => {
  const data = parseAmbulanceData(object)
  if (!data) return 0
  return knownNumber(data.transport?.patientCapacity) ?? knownNumber(data.crew.availableSeats) ?? 0
}

const ambulancePatientsOnBoard = (data: AmbulanceDomainData): number =>
  knownNumber(data.transport?.patientsOnBoard) ?? 0

const assignedAmbulanceCapacityFor = (
  incident: OperationalObject,
  objects: ReadonlyArray<OperationalObject>,
): number =>
  objects
    .filter(object => object.tasking?.currentTaskId === incident.id && parseAmbulanceData(object) !== null)
    .reduce((total, ambulance) => total + ambulanceCapacity(ambulance), 0)

const incidentDemand = (data: IncidentDomainData): number =>
  knownNumber(data.victims.count) ?? 1

const incidentStatus = (
  object: OperationalObject,
  data: IncidentDomainData,
  objects: ReadonlyArray<OperationalObject>,
): PackObjectStatusPresentation => {
  if (object.operational.status === 'resolved') {
    return packStatus('idle', 'Resolved')
  }
  const demand = incidentDemand(data)
  const assignedCapacity = assignedAmbulanceCapacityFor(object, objects)
  if (assignedCapacity === 0) {
    return packStatus('error', `No assigned ambulance capacity for ${demand} victim${demand === 1 ? '' : 's'}`)
  }
  if (assignedCapacity >= demand) return packStatus('ready', `Assigned capacity ${assignedCapacity}/${demand}`, { shape: 'dot', pulse: true })
  return packStatus('working', `Assigned capacity ${assignedCapacity}/${demand}`, { shape: 'dot', pulse: true })
}

const ambulanceStatus = (
  object: OperationalObject,
  data: AmbulanceDomainData,
  objects: ReadonlyArray<OperationalObject>,
): PackObjectStatusPresentation => {
  const patientsOnBoard = ambulancePatientsOnBoard(data)
  if (!object.tasking?.currentTaskId && patientsOnBoard === 0) {
    return packStatus('ready', 'Idle and empty')
  }
  if (object.tasking?.currentTaskId && patientsOnBoard === 0) {
    const target = objects.find(candidate => candidate.id === object.tasking?.currentTaskId)
    const incidentBound = target?.kind === 'incident'
    const hospitalBound = target?.kind === 'facility'
    return {
      tone: 'working',
      label: incidentBound ? 'En route to incident empty' : hospitalBound ? 'En route to hospital empty' : 'En route empty',
      indicator: incidentBound || hospitalBound
        ? { shape: 'arrow', direction: incidentBound ? 'right' : 'left', pulse: true }
        : { shape: 'dot', innerTone: 'ready', pulse: true },
    }
  }
  if (object.tasking?.currentTaskId && patientsOnBoard > 0) {
    const target = objects.find(candidate => candidate.id === object.tasking?.currentTaskId)
    const hospitalBound = target?.kind === 'facility'
    return {
      tone: 'working',
      label: hospitalBound ? 'En route to hospital with patient on board' : 'En route with patient on board',
      indicator: hospitalBound
        ? { shape: 'arrow', direction: 'left', pulse: true }
        : { shape: 'dot', pulse: true },
    }
  }
  if (patientsOnBoard > 0) return packStatus('working', 'Patient on board')
  return packStatus('idle', object.operational.status)
}

const hospitalStatus = (data: HospitalDomainData): PackObjectStatusPresentation => {
  const total = knownNumber(data.emergencyDepartment.traumaBedsTotal)
  const available = knownNumber(data.emergencyDepartment.traumaBedsAvailable)
  if (total === null || available === null || total === 0) return packStatus('idle', 'Trauma bed capacity unknown')
  const boundedAvailable = Math.max(0, Math.min(available, total))
  if (boundedAvailable === 0) return packStatus('error', `No trauma beds available (${boundedAvailable}/${total})`)
  if (boundedAvailable === 1) return packStatus('working', `Limited trauma beds available (${boundedAvailable}/${total})`)
  return packStatus('ready', `Trauma beds available ${boundedAvailable}/${total}`)
}

const traumaBedsAvailableText = (data: HospitalDomainData): string => {
  const total = knownNumber(data.emergencyDepartment.traumaBedsTotal)
  const available = knownNumber(data.emergencyDepartment.traumaBedsAvailable)
  if (total === null || available === null) return 'unknown'
  return `${Math.max(0, Math.min(available, total))} / ${total}`
}

const incidentDetails = (object: OperationalObject, data: IncidentDomainData, objects: ReadonlyArray<OperationalObject>): ReadonlyArray<PackObjectField> => [
  packField('triage', 'Triage', factText(data.triage)),
  packField('victims', 'Victims', factText(data.victims.count, String)),
  packField('assigned-capacity', 'Assigned capacity', `${assignedAmbulanceCapacityFor(object, objects)} / ${incidentDemand(data)}`),
  packField('injuries', 'Injuries', factText(data.victims.injuries, injuryText)),
  packField('hazards', 'Hazards', factText(data.hazards, listText)),
]

const hospitalDetails = (data: HospitalDomainData): ReadonlyArray<PackObjectField> => [
  packField('trauma-beds', 'Trauma beds', traumaBedsAvailableText(data)),
  packField('ambulance-bays', 'Ambulance bays', factText(data.emergencyDepartment.ambulanceBaysAvailable, String)),
  packField('patients-received', 'Patients received', factText(data.emergencyDepartment.patientsReceived, String)),
  packField('capabilities', 'Capabilities', listText(data.capabilities)),
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
    status: data ? ambulanceStatus(object, data, objects) : packStatus('error', 'Invalid ambulance domain data'),
    fields: data ? ambulanceDetails(object, data, objects) : [packField('error', 'Error', 'Invalid ambulance domain data')],
  }
}

const presentationForIncident = (
  object: OperationalObject,
  objects: ReadonlyArray<OperationalObject>,
): PackObjectPresentation => {
  const data = parseIncidentData(object)
  return {
    categoryId: 'incidents',
    icon: 'crash',
    color: '#c7352b',
    summary: data ? `victims ${factText(data.victims.count, String)} · triage ${factText(data.triage)}` : object.operational.status,
    status: data ? incidentStatus(object, data, objects) : packStatus('error', 'Invalid incident domain data'),
    fields: data ? incidentDetails(object, data, objects) : [packField('error', 'Error', 'Invalid incident domain data')],
    muted: object.operational.status === 'resolved',
  }
}

const presentationForHospital = (object: OperationalObject): PackObjectPresentation => {
  const data = parseHospitalData(object)
  return {
    categoryId: 'hospitals',
    icon: 'hospital',
    color: '#245b9f',
    summary: data
      ? `trauma beds ${traumaBedsAvailableText(data)} available · bays ${factText(data.emergencyDepartment.ambulanceBaysAvailable, String)}`
      : object.operational.status,
    status: data ? hospitalStatus(data) : packStatus('error', 'Invalid hospital domain data'),
    fields: data ? hospitalDetails(data) : [packField('error', 'Error', 'Invalid hospital domain data')],
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

const assertPointGeometry = (geometry: PackCreationGeometry) => {
  if (geometry.kind !== 'point') throw new Error(`ambulance object creation requires point geometry, got ${geometry.kind}`)
  return geometry.point
}

export const ambulancePack: LeitbildPack = {
  id: 'ambulance',
  name: 'Ambulance Dispatch',
  domain: ambulanceDomainId,
  scenarios: [osloAmbulanceTutorialScenario],
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
    { id: 'hospital', label: 'Hospital', categoryId: 'hospitals', icon: 'hospital', color: '#245b9f', placementKind: 'point' },
    { id: 'ambulance', label: 'Ambulance', categoryId: 'ambulances', icon: 'ambulance', color: '#22845d', placementKind: 'point' },
    { id: 'incident', label: 'Incident', categoryId: 'incidents', icon: 'crash', color: '#c7352b', placementKind: 'point' },
  ],
  interactionHandlers: [
    createAmbulanceArrivalInteractionHandler(),
  ],
  presentObject: (object, context): PackObjectPresentation => {
    if (parseAmbulanceData(object)) return presentationForAmbulance(object, context.objects)
    if (parseHospitalData(object)) return presentationForHospital(object)
    if (parseIncidentData(object)) return presentationForIncident(object, context.objects)
    return {
      categoryId: 'unknown',
      icon: 'unknown',
      color: '#667085',
      summary: object.operational.status,
      status: packStatus('idle', object.operational.status),
      fields: [packField('warning', 'Warning', 'Object is outside the ambulance pack vocabulary')],
    }
  },
  defaultObjectLabel: (typeId, context): string => {
    const type = assertCreatableType(typeId)
    const definition = ambulancePack.createObjectTypes.find(candidate => candidate.id === type)
    if (!definition) throw new Error(`missing create type definition: ${type}`)
    const index = countForCategory(context.objects, definition.categoryId) + 1
    return `${definition.label} ${index}`
  },
  buildCreateObjectCommand: (typeId, label, geometry): PackCommandRequest => {
    const point = assertPointGeometry(geometry)
    return {
      kind: createObjectCommandKind,
      targetObjectIds: [],
      payload: {
        objectType: assertCreatableType(typeId),
        label,
        point,
      },
    }
  },
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
