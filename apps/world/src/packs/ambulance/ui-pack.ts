import type { OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import { createWorldPackDescriptor, type PackObjectPresentation, type WorldPackView } from '../../core/packs/protocol.ts'
import { activeAssignmentStop, ambulanceDataOf, ambulancePackId, assignmentWarnings, patientObjects, patientPackDataSchema, unitPatients } from './model.ts'
import { ambulanceSimRuntimeId } from './sim/constants.ts'

const urgencyColor = { acute: '#dc4444', urgent: '#d49327', ordinary: '#3c8cab' }
const labelFor = (id: string, objects: ReadonlyArray<OperationalObject>) => objects.find(object => object.id === id)?.label ?? id
const join = (values: ReadonlyArray<string>) => values.length ? values.join(', ') : 'None configured'
const coLocatedWithSubject = (object: OperationalObject, subjectId: string | undefined, objects: ReadonlyArray<OperationalObject>): boolean => {
  if (!subjectId) return false
  const point = object.spatial.position?.point.coordinates
  const subjectPoint = objects.find(candidate => candidate.id === subjectId)?.spatial.position?.point.coordinates
  return !!point && !!subjectPoint && point[0] === subjectPoint[0] && point[1] === subjectPoint[1]
}
const typeOf = (object: OperationalObject) => object.packId === ambulancePackId ? ambulanceDataOf(object).type : null
const subjects = (object: OperationalObject, objects: ReadonlyArray<OperationalObject>) => objects.flatMap(candidate => {
  if (candidate.packId !== ambulancePackId) return []
  const data = ambulanceDataOf(candidate)
  return (data.type === 'incident' || data.type === 'care-site') && data.subjectObjectId === object.id ? [{ object: candidate, data }] : []
})

export const presentAmbulanceObject = (object: OperationalObject, objects: ReadonlyArray<OperationalObject>): PackObjectPresentation => {
  const data = ambulanceDataOf(object)
  if (data.type === 'ambulance') return {
    categoryId: 'ambulances', icon: 'ambulance', color: '#22845d',
    summary: data.assignment?.phase ?? (data.crewReady ? 'Available' : 'Crew unavailable'),
    status: packStatus(data.assignment ? 'working' : data.crewReady ? 'ready' : 'error', data.assignment?.phase ?? (data.crewReady ? 'Available' : 'Out of service')),
    fields: [
      packField('capacity', 'Transport capacity', String(data.patientCapacity)),
      packField('on-board', 'Patients on board', String(unitPatients(object.id, objects).length)),
      packField('patients', 'Assigned patients', (data.assignment?.patientIds ?? []).map(id => labelFor(id, objects)).join(', ') || 'None'),
      packField('capabilities', 'Capabilities', join(data.capabilities)),
      packField('mobilization', 'Configured mobilization', data.mobilizationSeconds + ' s'),
      packField('scene', 'Configured scene service', data.sceneSeconds + ' s'),
      ...(data.assignment ? [packField('plan', 'Remaining stops', data.assignment.stops.slice(data.assignment.activeStopIndex).map(stop => stop.kind === 'return-base' ? 'Return to base' : labelFor(stop.targetId, objects)).join(' → '))] : []),
      ...(object.spatial.route?.etaSeconds !== undefined ? [packField('eta', 'Route ETA', Math.ceil(object.spatial.route.etaSeconds) + ' simulated seconds')] : []),
      ...assignmentWarnings(object, objects).map((reason, index) => packField('warning-' + index, 'Review assignment', reason)),
    ],
  }
  if (data.type === 'incident') {
    const patients = patientObjects(objects).filter(patient => patientPackDataSchema.parse(patient.packData).incidentId === object.id)
    const active = patients.filter(patient => patientPackDataSchema.parse(patient.packData).disposition === 'active').length
    return {
      categoryId: 'incidents', icon: 'triangle-alert', color: urgencyColor[data.dispatchUrgency],
      summary: data.summary, status: packStatus(data.closedAtMs !== undefined ? 'idle' : data.firstArrivalAtMs !== undefined ? 'working' : 'error', data.closedAtMs !== undefined ? 'Resolved' : data.firstArrivalAtMs !== undefined ? 'Response arrived' : 'Awaiting first response'),
      mapIconVisible: !coLocatedWithSubject(object, data.subjectObjectId, objects), muted: data.closedAtMs !== undefined, noteworthyUpdates: true,
      fields: [packField('urgency', 'Dispatch urgency', data.dispatchUrgency), packField('patients', 'Active / all patients', active + ' / ' + patients.length),
        ...(data.subjectObjectId ? [packField('subject', 'At asset', labelFor(data.subjectObjectId, objects))] : []),
        ...(data.firstArrivalAtMs !== undefined ? [packField('response', 'First response interval', ((data.firstArrivalAtMs - data.receivedAtMs) / 1000).toFixed(0) + ' s')] : []),
      ],
    }
  }
  if (data.type === 'patient') return {
    categoryId: 'patients', icon: 'plus', color: urgencyColor[data.assessedUrgency], summary: data.summary,
    status: packStatus(data.disposition === 'active' ? 'working' : 'idle', data.disposition === 'active' ? data.holder.kind : data.disposition),
    mapIconVisible: false, muted: data.disposition !== 'active', noteworthyUpdates: true,
    fields: [packField('urgency', 'Assessed urgency', data.assessedUrgency), packField('needs', 'Required capabilities', join(data.needs)), packField('incident', 'Incident', labelFor(data.incidentId, objects)), packField('holder', 'Currently with', labelFor(data.holder.id, objects)), ...(data.dispositionReason ? [packField('reason', 'Disposition reason', data.dispositionReason)] : [])],
  }
  const serving = objects.filter(candidate => {
    if (candidate.packId !== ambulancePackId) return false
    const other = ambulanceDataOf(candidate)
    if (other.type !== 'ambulance' || other.assignment?.phase !== 'handover') return false
    const stop = activeAssignmentStop(other.assignment)
    return stop.kind === 'handover' && stop.targetId === object.id
  }).length
  return {
    categoryId: 'care-sites', icon: 'plus', color: '#3479ac', summary: data.accepting ? 'Accepting: ' + data.acceptedUrgencies.join(', ') : 'Not accepting arrivals',
    status: packStatus(!data.accepting ? 'error' : serving >= data.handoverSlots ? 'working' : 'ready', !data.accepting ? 'Closed to arrivals' : `${serving}/${data.handoverSlots} handover slots occupied`),
    mapIconVisible: !coLocatedWithSubject(object, data.subjectObjectId, objects), noteworthyUpdates: true,
    fields: [packField('capabilities', 'Capabilities', join(data.capabilities)), packField('urgencies', 'Accepted urgency', data.acceptedUrgencies.join(', ')), packField('slots', 'Handover slots', String(data.handoverSlots)), packField('duration', 'Configured handover', data.handoverSeconds + ' s'), ...(data.subjectObjectId ? [packField('subject', 'At asset', labelFor(data.subjectObjectId, objects))] : [])],
  }
}

export const ambulancePackView = {
  descriptor: createWorldPackDescriptor({ id: ambulancePackId, version: '1.0.0', name: 'Ambulance Dispatch', description: 'Configurable response units, incidents, individual patient custody, flexible care sites and dispatch/handover workflows. Operational research model; not patient physiology.', contributions: ['runtime', 'recording', 'scenario', 'presentation'] }),
  runtime: { runtimes: [{ id: ambulanceSimRuntimeId, version: '1.0.0', label: 'Local ambulance runtime', kind: 'local', clock: 'simulation' }], defaultRuntimeId: ambulanceSimRuntimeId },
  presentation: {
    categories: (['ambulance', 'incident', 'patient', 'care-site'] as const).map(type => ({
      id: ({ ambulance: 'ambulances', incident: 'incidents', patient: 'patients', 'care-site': 'care-sites' } as const)[type],
      label: ({ ambulance: 'Ambulances', incident: 'Incidents', patient: 'Patients', 'care-site': 'Care sites' } as const)[type],
      emptyLabel: 'No ' + ({ ambulance: 'ambulances', incident: 'incidents', patient: 'patients', 'care-site': 'care sites' } as const)[type], matches: object => typeOf(object) === type,
    })),
    presentObject: (object, context) => presentAmbulanceObject(object, context.objects),
    contextualFields: (object, context) => subjects(object, context.objects).map(entry => packField('ambulance:' + entry.object.id, entry.data.type === 'incident' ? 'Incident at this asset' : 'Care site at this asset', entry.object.label + ' · ' + entry.object.operational.status)),
  },
} satisfies WorldPackView
