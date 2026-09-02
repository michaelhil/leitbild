import { recordingSeriesIdFor } from '../../core/model/index.ts'
import type {
  IsoTimestamp,
  OperationalObject,
  PackRuntimeRecordingBatch,
  RecordingProfileDescriptor,
  RecordingSeriesDescriptor,
  ScenarioRecordingSelection,
} from '../../core/model/index.ts'
import { ambulancePackDataSchema, ambulancePackId, hospitalPackDataSchema, incidentPackDataSchema } from './model.ts'

export const ambulanceRecordingProfiles: ReadonlyArray<RecordingProfileDescriptor> = [{
  id: 'operations',
  title: 'Operations',
  description: 'Status, position, speed, patient demand, and receiving capacity for ambulance operations.',
  defaultIntervalMs: 1_000,
  minimumIntervalMs: 1_000,
}]

export interface AmbulanceRecordingPlan {
  readonly intervalMs: number
  readonly sample: (config: {
    readonly objects: ReadonlyArray<OperationalObject>
    readonly observedAt: IsoTimestamp
    readonly simulationTime: IsoTimestamp
    readonly elapsedMs: number
  }) => PackRuntimeRecordingBatch
}

interface Observation {
  readonly signalId: string
  readonly title: string
  readonly value: number | string
  readonly quantity?: string
  readonly unit?: string
}

export const observationsFor = (object: OperationalObject): ReadonlyArray<Observation> => {
  const observations: Observation[] = [{
    signalId: 'operational.status',
    title: 'Status',
    value: object.operational.status,
  }]
  const point = object.spatial.position?.point
  if (point) {
    observations.push(
      { signalId: 'spatial.longitude', title: 'Longitude', value: point.coordinates[0], quantity: 'longitude', unit: 'deg' },
      { signalId: 'spatial.latitude', title: 'Latitude', value: point.coordinates[1], quantity: 'latitude', unit: 'deg' },
    )
  }
  if (object.spatial.position?.speedMps !== undefined) {
    observations.push({
      signalId: 'spatial.speedMps',
      title: 'Speed',
      value: object.spatial.position.speedMps,
      quantity: 'speed',
      unit: 'm/s',
    })
  }

  const ambulance = ambulancePackDataSchema.safeParse(object.packData)
  const patientsOnBoard = ambulance.success ? ambulance.data.transport?.patientsOnBoard : undefined
  if (patientsOnBoard !== undefined && patientsOnBoard.state !== 'unknown') {
    observations.push({
      signalId: 'ambulance.patientsOnBoard',
      title: 'Patients on board',
      value: patientsOnBoard.value,
      quantity: 'count',
    })
  }
  const incident = incidentPackDataSchema.safeParse(object.packData)
  if (incident.success && incident.data.victims.count.state !== 'unknown') {
    observations.push({
      signalId: 'incident.victims',
      title: 'Victims',
      value: incident.data.victims.count.value,
      quantity: 'count',
    })
  }
  const hospital = hospitalPackDataSchema.safeParse(object.packData)
  if (hospital.success) {
    const { traumaBedsAvailable, ambulanceBaysAvailable } = hospital.data.emergencyDepartment
    if (traumaBedsAvailable.state !== 'unknown') {
      observations.push({
        signalId: 'hospital.traumaBedsAvailable',
        title: 'Trauma beds available',
        value: traumaBedsAvailable.value,
        quantity: 'count',
      })
    }
    if (ambulanceBaysAvailable.state !== 'unknown') {
      observations.push({
        signalId: 'hospital.ambulanceBaysAvailable',
        title: 'Ambulance bays available',
        value: ambulanceBaysAvailable.value,
        quantity: 'count',
      })
    }
  }
  return observations
}

export const createAmbulanceRecordingPlan = (selection: ScenarioRecordingSelection): AmbulanceRecordingPlan => {
  if (selection.packId !== ambulancePackId) {
    throw new Error(`ambulance runtime received recording selection for Pack ${selection.packId}`)
  }
  const profile = ambulanceRecordingProfiles.find(candidate => candidate.id === selection.profileId)
  if (!profile) throw new Error(`unknown ambulance recording profile: ${selection.profileId}`)
  const intervalMs = selection.intervalMs ?? profile.defaultIntervalMs
  if (intervalMs < profile.minimumIntervalMs) {
    throw new Error(`ambulance recording profile ${profile.id} requires an interval of at least ${profile.minimumIntervalMs} ms`)
  }
  const describedSeries = new Set<string>()
  return {
    intervalMs,
    sample: ({ objects, observedAt, simulationTime, elapsedMs }) => {
      const descriptors: RecordingSeriesDescriptor[] = []
      const samples: PackRuntimeRecordingBatch['samples'] = []
      for (const object of objects) {
        if (object.packId !== ambulancePackId) continue
        for (const observation of observationsFor(object)) {
          const seriesId = recordingSeriesIdFor(object.id, observation.signalId)
          if (!describedSeries.has(seriesId)) {
            describedSeries.add(seriesId)
            descriptors.push({
              id: seriesId,
              subjectId: object.id,
              signalId: observation.signalId,
              title: `${object.label} · ${observation.title}`,
              valueType: typeof observation.value === 'number' ? 'number' : 'string',
              ...(observation.quantity === undefined ? {} : { quantity: observation.quantity }),
              ...(observation.unit === undefined ? {} : { unit: observation.unit }),
            })
          }
          samples.push({
            seriesId,
            observedAt,
            simulationTime,
            elapsedMs,
            value: observation.value,
            quality: 'good',
          })
        }
      }
      return { descriptors, samples }
    },
  }
}
