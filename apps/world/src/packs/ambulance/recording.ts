import { recordingSeriesIdFor } from '../../core/model/index.ts'
import type {
  IsoTimestamp,
  OperationalObject,
  PackRuntimeRecordingBatch,
  RecordingProfileDescriptor,
  RecordingSeriesDescriptor,
  ScenarioRecordingSelection,
} from '../../core/model/index.ts'
import { ambulanceDataOf, ambulancePackId } from './model.ts'

export const ambulanceRecordingProfiles: ReadonlyArray<RecordingProfileDescriptor> = [{
  id: 'operations',
  title: 'Operations',
  description: 'Operational status, movement, patient custody/disposition, real workflow intervals and configured receiving capacity. No synthetic clinical measurements.',
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
  readonly value: number | string | boolean
  readonly quantity?: string
  readonly unit?: string
}

export const observationsFor = (object: OperationalObject): ReadonlyArray<Observation> => {
  if (object.packId !== ambulancePackId) return []
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

  const data = ambulanceDataOf(object)
  if (data.type === 'response-unit') observations.push(
    { signalId: 'response-unit.kind', title: 'Unit kind', value: data.unitKind },
    { signalId: 'response-unit.phase', title: 'Workflow phase', value: data.assignment?.phase ?? 'unassigned' },
    { signalId: 'response-unit.crewReady', title: 'Crew ready', value: data.crewReady },
    { signalId: 'response-unit.assignedPatients', title: 'Assigned patients', value: data.assignment?.patientIds.length ?? 0, quantity: 'count' },
    { signalId: 'response-unit.busySeconds', title: 'Accumulated busy time', value: data.busyTimeMs / 1000, quantity: 'time', unit: 's' },
  )
  if (data.type === 'incident') {
    observations.push({ signalId: 'incident.dispatchUrgency', title: 'Dispatch urgency', value: data.dispatchUrgency })
    if (data.firstArrivalAtMs !== undefined) observations.push({ signalId: 'incident.firstResponseSeconds', title: 'First response interval', value: (data.firstArrivalAtMs - data.receivedAtMs) / 1000, quantity: 'time', unit: 's' })
  }
  if (data.type === 'patient') {
    observations.push(
      { signalId: 'patient.assessedUrgency', title: 'Assessed urgency', value: data.assessedUrgency },
      { signalId: 'patient.disposition', title: 'Disposition', value: data.disposition },
      { signalId: 'patient.holderKind', title: 'Custody type', value: data.holder.kind },
      { signalId: 'patient.holderId', title: 'Custody holder', value: data.holder.id },
    )
    for (const [id, title, start, end] of [
      ['dispatchWaitSeconds', 'Time to dispatch assignment', data.createdAtMs, data.assignedAtMs],
      ['mobilizationSeconds', 'Mobilization time', data.assignedAtMs, data.departedAtMs],
      ['contactSeconds', 'Time to patient contact', data.createdAtMs, data.contactedAtMs],
      ['transportSeconds', 'Pickup to current receiving-site arrival', data.pickedUpAtMs, data.arrivedAtSiteMs],
      ['handoverWaitSeconds', 'Current receiving-site queue wait', data.arrivedAtSiteMs, data.handoverStartedAtMs],
      ['handoverSeconds', 'Handover duration', data.handoverStartedAtMs, data.completedAtMs],
    ] as const) if (start !== undefined && end !== undefined) {
      if (end < start) throw new Error('Ambulance milestone precedes its starting milestone')
      observations.push({ signalId: 'patient.' + id, title, value: (end - start) / 1000, quantity: 'time', unit: 's' })
    }
  }
  if (data.type === 'care-site') observations.push(
    { signalId: 'care-site.accepting', title: 'Accepting arrivals', value: data.accepting },
    { signalId: 'care-site.handoverSlots', title: 'Configured handover slots', value: data.handoverSlots, quantity: 'count' },
    { signalId: 'care-site.handoverSeconds', title: 'Configured handover duration', value: data.handoverSeconds, quantity: 'time', unit: 's' },
  )
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
              valueType: typeof observation.value as 'number' | 'boolean' | 'string',
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
