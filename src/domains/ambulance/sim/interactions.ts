import type { AdapterId, IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { confirmedFact, estimatedFact, type KnowledgeFact } from '../../../core/model/index.ts'
import {
  ambulanceDomainDataSchema,
  hospitalDomainDataSchema,
  incidentDomainDataSchema,
  type AmbulanceDomainData,
  type HospitalDomainData,
  type IncidentDomainData,
} from '../model.ts'

export interface AmbulanceArrivalInteractionInput {
  readonly ambulance: OperationalObject
  readonly target: OperationalObject
  readonly at: IsoTimestamp
  readonly adapterId: AdapterId
}

export interface AmbulanceArrivalInteractionResult {
  readonly upserts: ReadonlyArray<OperationalObject>
  readonly deletes: ReadonlyArray<ObjectId>
}

const knownNumber = (fact: KnowledgeFact<number> | undefined): number | null =>
  !fact || fact.state === 'unknown' ? null : fact.value

const numberFactWithValue = (
  fact: KnowledgeFact<number> | undefined,
  value: number,
  at: IsoTimestamp,
): KnowledgeFact<number> => {
  if (!fact || fact.state === 'unknown') return estimatedFact(value, at, 'simulation', 0.7)
  return fact.state === 'confirmed'
    ? confirmedFact(value, at, 'simulation', fact.confidence)
    : estimatedFact(value, at, 'simulation', fact.confidence)
}

const ambulanceDataOf = (object: OperationalObject): AmbulanceDomainData | null => {
  const parsed = ambulanceDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const incidentDataOf = (object: OperationalObject): IncidentDomainData | null => {
  const parsed = incidentDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const hospitalDataOf = (object: OperationalObject): HospitalDomainData | null => {
  const parsed = hospitalDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const ambulanceWithData = (
  ambulance: OperationalObject,
  data: AmbulanceDomainData,
  at: IsoTimestamp,
  adapterId: AdapterId,
  status: string,
  intent?: string,
): OperationalObject => ({
  ...ambulance,
  revision: ambulance.revision + 1,
  operational: {
    ...ambulance.operational,
    status,
    ...(intent === undefined ? {} : { intent }),
  },
  domainData: data,
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: ambulance.id,
  },
  timestamps: {
    ...ambulance.timestamps,
    updatedAt: at,
  },
})

const objectWithDomainData = (
  object: OperationalObject,
  domainData: IncidentDomainData | HospitalDomainData,
  at: IsoTimestamp,
  adapterId: AdapterId,
  status?: string,
): OperationalObject => ({
  ...object,
  revision: object.revision + 1,
  ...(status === undefined
    ? {}
    : {
        operational: {
          ...object.operational,
          status,
        },
      }),
  domainData,
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: object.id,
  },
  timestamps: {
    ...object.timestamps,
    updatedAt: at,
  },
})

const arrivalWithoutTransfer = (
  ambulance: OperationalObject,
): AmbulanceArrivalInteractionResult => ({
  upserts: [ambulance],
  deletes: [],
})

const handleIncidentArrival = (
  input: AmbulanceArrivalInteractionInput,
  ambulanceData: AmbulanceDomainData,
  incidentData: IncidentDomainData,
): AmbulanceArrivalInteractionResult => {
  const capacity = knownNumber(ambulanceData.transport?.patientCapacity) ?? knownNumber(ambulanceData.crew.availableSeats) ?? 0
  const onBoard = knownNumber(ambulanceData.transport?.patientsOnBoard) ?? 0
  const victimCount = knownNumber(incidentData.victims.count)
  const availableCapacity = Math.max(0, capacity - onBoard)
  if (availableCapacity === 0 || victimCount === null || victimCount === 0) {
    return arrivalWithoutTransfer(input.ambulance)
  }

  const transferCount = Math.min(availableCapacity, victimCount)
  const nextVictimCount = victimCount - transferCount
  const nextAmbulanceData: AmbulanceDomainData = {
    ...ambulanceData,
    transport: {
      patientCapacity: ambulanceData.transport?.patientCapacity ?? confirmedFact(capacity, input.at, 'simulation', 1),
      patientsOnBoard: numberFactWithValue(ambulanceData.transport?.patientsOnBoard, onBoard + transferCount, input.at),
    },
  }
  const nextAmbulance = ambulanceWithData(
    input.ambulance,
    nextAmbulanceData,
    input.at,
    input.adapterId,
    'on_scene',
    'patient_loaded',
  )
  const nextIncidentData: IncidentDomainData = {
    ...incidentData,
    victims: {
      ...incidentData.victims,
      count: numberFactWithValue(incidentData.victims.count, nextVictimCount, input.at),
    },
  }

  if (nextVictimCount === 0) {
    return {
      upserts: [nextAmbulance],
      deletes: [input.target.id],
    }
  }

  return {
    upserts: [
      nextAmbulance,
      objectWithDomainData(input.target, nextIncidentData, input.at, input.adapterId, 'responding'),
    ],
    deletes: [],
  }
}

const diversionForBeds = (bedsAvailable: number): 'open' | 'limited' | 'closed' => {
  if (bedsAvailable === 0) return 'closed'
  if (bedsAvailable === 1) return 'limited'
  return 'open'
}

const handleHospitalArrival = (
  input: AmbulanceArrivalInteractionInput,
  ambulanceData: AmbulanceDomainData,
  hospitalData: HospitalDomainData,
): AmbulanceArrivalInteractionResult => {
  const onBoard = knownNumber(ambulanceData.transport?.patientsOnBoard) ?? 0
  if (onBoard === 0) return arrivalWithoutTransfer(input.ambulance)

  const bedsAvailable = knownNumber(hospitalData.emergencyDepartment.traumaBedsAvailable) ?? 0
  if (bedsAvailable === 0) {
    return {
      upserts: [ambulanceWithData(input.ambulance, ambulanceData, input.at, input.adapterId, 'at_hospital', 'awaiting_hospital_capacity')],
      deletes: [],
    }
  }

  const transferCount = Math.min(onBoard, bedsAvailable)
  const remainingOnBoard = onBoard - transferCount
  const remainingBeds = bedsAvailable - transferCount
  const patientsReceived = knownNumber(hospitalData.emergencyDepartment.patientsReceived) ?? 0
  const nextAmbulanceData: AmbulanceDomainData = {
    ...ambulanceData,
    transport: {
      patientCapacity: ambulanceData.transport?.patientCapacity ?? confirmedFact(onBoard, input.at, 'simulation', 1),
      patientsOnBoard: numberFactWithValue(ambulanceData.transport?.patientsOnBoard, remainingOnBoard, input.at),
    },
  }
  const nextHospitalData: HospitalDomainData = {
    ...hospitalData,
    emergencyDepartment: {
      ...hospitalData.emergencyDepartment,
      traumaBedsAvailable: numberFactWithValue(hospitalData.emergencyDepartment.traumaBedsAvailable, remainingBeds, input.at),
      patientsReceived: numberFactWithValue(hospitalData.emergencyDepartment.patientsReceived, patientsReceived + transferCount, input.at),
      diversionStatus: confirmedFact(diversionForBeds(remainingBeds), input.at, 'simulation', 1),
    },
  }

  return {
    upserts: [
      ambulanceWithData(
        input.ambulance,
        nextAmbulanceData,
        input.at,
        input.adapterId,
        remainingOnBoard === 0 ? 'available' : 'at_hospital',
        remainingOnBoard === 0 ? undefined : 'awaiting_hospital_capacity',
      ),
      objectWithDomainData(input.target, nextHospitalData, input.at, input.adapterId),
    ],
    deletes: [],
  }
}

export const applyAmbulanceArrivalInteraction = (
  input: AmbulanceArrivalInteractionInput,
): AmbulanceArrivalInteractionResult => {
  const ambulanceData = ambulanceDataOf(input.ambulance)
  if (!ambulanceData) return arrivalWithoutTransfer(input.ambulance)

  const incidentData = incidentDataOf(input.target)
  if (incidentData) return handleIncidentArrival(input, ambulanceData, incidentData)

  const hospitalData = hospitalDataOf(input.target)
  if (hospitalData) return handleHospitalArrival(input, ambulanceData, hospitalData)

  return arrivalWithoutTransfer(input.ambulance)
}
