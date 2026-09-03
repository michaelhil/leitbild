import { describe, expect, test } from 'bun:test'
import { geoJsonPointSchema, geoPointFromLonLat, packIdSchema, type OperationalObject } from '../../core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../../core/scenarios/authoring.ts'
import { ambulanceItemSchema } from './item-schemas.ts'
import { ambulancePack } from './pack.ts'
import { ambulanceDataOf, assignmentWarnings, dispatchEligibility, patientPackDataSchema } from './model.ts'
import { ambulanceMetricsSchema, ambulanceQueryCapabilities, answerAmbulanceQuery, dispatchOptionsSchema, dispatchStateSchema } from './query.ts'
import { createAmbulanceRecordingPlan, observationsFor } from './recording.ts'
import { createAmbulanceItem } from './sim/object-state.ts'
import { ambulancePackView, presentAmbulanceObject } from './ui-pack.ts'

const start = Date.parse('2026-01-01T09:00:00Z')
const at = '2026-03-01T09:00:00.000Z' as OperationalObject['timestamps']['createdAt']
const incidentItem = { type: 'incident', id: 'incident:a', label: 'Test incident', position: [11, 59], summary: 'Synthetic dispatch test', dispatchUrgency: 'acute' }
const unitItem = { type: 'ambulance', id: 'ambulance:a', label: 'Test unit', position: [11.01, 59], patientCapacity: 1, capabilities: ['monitoring'], crewReady: true, mobilizationSeconds: 2, sceneSeconds: 3 }
const patientItem = { type: 'patient', id: 'patient:a', label: 'Test patient', incidentId: 'incident:a', summary: 'Explicit demand', assessedUrgency: 'urgent', needs: ['monitoring'] }
const siteItem = { type: 'care-site', id: 'site:a', label: 'Test care site', position: [11.02, 59], capabilities: ['monitoring'], acceptedUrgencies: ['acute', 'urgent', 'ordinary'], handoverSlots: 1, handoverSeconds: 4, accepting: true }
const build = (items: readonly unknown[] = [incidentItem, unitItem, patientItem, siteItem]): OperationalObject[] => {
  const objects: OperationalObject[] = []
  for (const item of items) objects.push(createAmbulanceItem(ambulanceItemSchema.parse(item), { at, simulationTimeMs: start, objectById: id => objects.find(object => object.id === id) }))
  return objects
}
const query = (kind: string, objects = build(), input: unknown = {}) => answerAmbulanceQuery({ request: { capabilityId: 'world.ambulance.' + kind, input }, objects, at, simulationTimeMs: start + 30_000 })
const update = (object: OperationalObject, patch: Record<string, unknown>): OperationalObject => ({ ...object, packData: { ...ambulanceDataOf(object), ...patch } })
const route = { geometry: { type: 'LineString' as const, coordinates: [[11.01, 59], [11, 59]] }, durationMs: 10_000, distanceM: 100, provider: 'test' }
const pickupStop = { kind: 'pickup' as const, targetId: 'incident:a', patientIds: ['patient:a'], route }
const assignment = { phase: 'responding', stops: [pickupStop], activeStopIndex: 0, patientIds: ['patient:a'], startedAtMs: start, phaseStartedAtMs: start + 2_000, leg: { ...route, progressMs: 0 } }

describe('Ambulance bounded AI read surface', () => {
  test('separates simulation and observation clocks, resolves patient holder position, and excludes route dumps', () => {
    const objects = build()
    const state = dispatchStateSchema.parse(query('dispatch-state', objects))
    expect(state.simulationTimeMs).toBe(start + 30_000)
    expect(state.observedAt).toBe(at)
    expect(state.totals).toEqual({ units: 1, incidents: 1, patients: 1, careSites: 1 })
    expect(state.patients[0]!.point).toEqual(geoJsonPointSchema.parse(geoPointFromLonLat(11, 59)))
    expect(state.units[0]!.remainingTravelSeconds).toBeNull()
    expect(state.units[0]).not.toHaveProperty('packData')
    expect(state.units[0]).not.toHaveProperty('route')
    expect(ambulanceQueryCapabilities.map(capability => capability.id)).toEqual(['world.ambulance.dispatch-state', 'world.ambulance.object', 'world.ambulance.dispatch-options', 'world.ambulance.metrics'])
  })

  test('bounded pagination and incident filtering have explicit totals without evaluating the full candidate fleet', () => {
    const objects = build([incidentItem, patientItem, siteItem, ...Array.from({ length: 105 }, (_, index) => ({ ...unitItem, id: 'ambulance:' + index }))])
    const state = dispatchStateSchema.parse(query('dispatch-state', objects, { limit: 100 }))
    expect(state.units).toHaveLength(100)
    expect(state.totals.units).toBe(105)
    expect(state.truncated).toBe(true)
    const next = dispatchStateSchema.parse(query('dispatch-state', objects, { limit: 100, offset: 100 }))
    expect(next.units).toHaveLength(5)
    expect(next.truncated).toBe(false)
    const options = dispatchOptionsSchema.parse(query('dispatch-options', objects, { action: 'assign', incidentId: 'incident:a', patientIds: ['patient:a'], limit: 100, offset: 100 }))
    expect(options.candidates).toHaveLength(5)
    expect(options.total).toBe(105)
    expect(dispatchStateSchema.parse(query('dispatch-state', objects, { incidentId: 'incident:missing' })).patients).toHaveLength(0)
    expect(() => query('dispatch-state', objects, { limit: 101 })).toThrow()
  })

  test('candidate rejection reasons are the exact engine checks; duplicate selected patients fail validation', () => {
    const objects = build()
    objects[1] = update(objects[1]!, { crewReady: false })
    objects[3] = update(objects[3]!, { capabilities: [], accepting: false })
    const input = { action: 'assign', incidentId: 'incident:a', patientIds: ['patient:a'] }
    const options = dispatchOptionsSchema.parse(query('dispatch-options', objects, input))
    expect(options.candidates[0]!.reasons).toEqual(dispatchEligibility(objects[1], objects[0], [objects[2]!], objects))
    expect(options.candidates[0]!.eligible).toBe(false)
    expect(() => query('dispatch-options', objects, { ...input, patientIds: ['patient:a', 'patient:a'] })).toThrow('Patient IDs must be unique')
    expect(() => query('dispatch-options', objects, { ...input, patientIds: ['patient:missing'] })).toThrow('Patient does not exist')
  })

  test('current route ETA accounts for weather and becomes unknown when blocked; changing needs expose assignment warnings', () => {
    const objects = build()
    objects[1] = { ...update(objects[1]!, { assignment }), spatial: { ...objects[1]!.spatial, route: { etaSeconds: 20, source: 'simulator' } } }
    objects[2] = update(objects[2]!, { needs: ['specialist-care'], holder: { kind: 'ambulance', id: 'ambulance:a' } })
    const state = dispatchStateSchema.parse(query('dispatch-state', objects))
    expect(state.units[0]!.remainingTravelSeconds).toBe(20)
    expect(state.units[0]!.assignmentWarnings).toEqual(assignmentWarnings(objects[1]!, objects))
    expect(state.units[0]!.assignmentWarnings[0]).toContain('specialist-care')
    expect(state.patients[0]!.point).toEqual(geoJsonPointSchema.parse(objects[1]!.spatial.position!.point))
    objects[1] = { ...objects[1]!, spatial: { ...objects[1]!.spatial, route: { source: 'simulator' } } }
    expect(dispatchStateSchema.parse(query('dispatch-state', objects)).units[0]!.remainingTravelSeconds).toBeNull()
  })

  test('distinguishes reserved from on-board patients and shows actual queue/slot occupants', () => {
    const objects = build()
    const handover = { kind: 'handover' as const, targetId: 'site:a', patientIds: ['patient:a'], route: { ...route, geometry: { type: 'LineString' as const, coordinates: [[11, 59], [11.02, 59]] } } }
    objects[1] = update(objects[1]!, { assignment: { ...assignment, phase: 'queued', stops: [pickupStop, handover], activeStopIndex: 1, leg: undefined } })
    let state = dispatchStateSchema.parse(query('dispatch-state', objects))
    expect(state.units[0]!.patientIds.map(String)).toEqual(['patient:a'])
    expect(state.units[0]!.onBoardPatientIds).toEqual([])
    expect(state.careSites[0]!.queuedUnitIds.map(String)).toEqual(['ambulance:a'])
    objects[2] = update(objects[2]!, { holder: { kind: 'ambulance', id: 'ambulance:a' } })
    state = dispatchStateSchema.parse(query('dispatch-state', objects))
    expect(state.units[0]!.onBoardPatientIds.map(String)).toEqual(['patient:a'])
    expect(state.careSites[0]!.handingOverUnitIds).toEqual([])
  })

  test('missing measurements remain null while measured zero is a real sample; metrics reject reversed milestones', () => {
    const objects = build()
    const empty = ambulanceMetricsSchema.parse(query('metrics', objects))
    expect(empty.incidents.firstResponse).toEqual({ samples: 0, meanSeconds: null, maximumSeconds: null })
    objects[2] = update(objects[2]!, { assignedAtMs: start, departedAtMs: start + 2_000, contactedAtMs: start + 12_000, pickedUpAtMs: start + 15_000, arrivedAtSiteMs: start + 25_000, handoverStartedAtMs: start + 25_000, completedAtMs: start + 29_000, holder: { kind: 'care-site', id: 'site:a' }, disposition: 'delivered' })
    const completed = ambulanceMetricsSchema.parse(query('metrics', objects))
    expect(completed.patients.dispatchWait).toEqual({ samples: 1, meanSeconds: 0, maximumSeconds: 0 })
    expect(completed.patients.mobilization.meanSeconds).toBe(2)
    expect(completed.patients.timeToContact.meanSeconds).toBe(12)
    expect(completed.patients.transport.meanSeconds).toBe(10)
    expect(completed.patients.handoverWait.meanSeconds).toBe(0)
    expect(completed.patients.handover.meanSeconds).toBe(4)
    objects[2] = update(objects[2]!, { completedAtMs: start })
    expect(() => query('metrics', objects)).toThrow('precedes')
  })

  test('returning units are explicitly both assigned and dispatchable; exact object reads distinguish missing', () => {
    const objects = build()
    objects[1] = update(objects[1]!, { assignment: { phase: 'returning', stops: [{ kind: 'return-base', patientIds: [], route }], activeStopIndex: 0, patientIds: [], startedAtMs: start, phaseStartedAtMs: start, leg: { ...route, progressMs: 0 } } })
    expect(ambulanceMetricsSchema.parse(query('metrics', objects)).units).toEqual({ total: 1, dispatchable: 1, assigned: 1, busySeconds: 0 })
    expect(query('object', objects, { objectId: 'patient:a' })).toEqual({ object: objects[2]! })
    expect(query('object', objects, { objectId: 'patient:missing' })).toEqual({ object: null })
  })
})

describe('Ambulance presentation, discovery and recording', () => {
  test('map assignment discovers casualties, builds authoritative commands and exposes extension handles', () => {
    const objects = build()
    const contribution = ambulancePackView.mapAssignment!
    expect(contribution.canStart(objects[1]!, { objects })).toBe(true)
    const target = contribution.targetFor(objects[1]!, objects[0]!, 'start', { objects })
    expect(target?.choices).toEqual([expect.objectContaining({ id: 'patient:a', label: 'Test patient' })])
    expect(target?.buildCommand(['patient:a'])).toMatchObject({ kind: 'world.ambulance.assign', payload: { ambulanceId: 'ambulance:a', incidentId: 'incident:a', patientIds: ['patient:a'] } })

    const assigned = update(objects[1]!, { assignment })
    const assignedObjects = objects.map(object => object.id === assigned.id ? assigned : object)
    expect(contribution.handles({ objects: assignedObjects })).toEqual([expect.objectContaining({ controllerId: 'ambulance:a' })])
    const handover = contribution.targetFor(assigned, objects[3]!, 'append', { objects: assignedObjects })
    expect(handover?.buildCommand([])).toMatchObject({ kind: 'world.ambulance.append-stop', payload: { kind: 'handover', careSiteId: 'site:a', patientIds: ['patient:a'] } })
  })

  test('atObject avoids a duplicate marker only while co-located; a removed/moved subject cannot hide an incident', () => {
    const objects = build()
    const subject: OperationalObject = { ...objects[1]!, id: 'plant:a' as OperationalObject['id'], packId: packIdSchema.parse('process-plant'), packData: { type: 'plant' } }
    const anchored = { ...update(objects[0]!, { subjectObjectId: subject.id }), spatial: subject.spatial }
    expect(presentAmbulanceObject(anchored, [anchored, subject]).mapIconVisible).toBe(false)
    expect(presentAmbulanceObject(anchored, [anchored]).mapIconVisible).toBe(true)
    const moved = { ...subject, spatial: { ...subject.spatial, position: { point: geoPointFromLonLat(12, 60), observedAt: at } } }
    expect(presentAmbulanceObject(anchored, [anchored, moved]).mapIconVisible).toBe(true)
    expect(ambulancePackView.presentation.contextualFields(subject, { objects: [anchored, subject] } as never)[0]!.value).toContain(anchored.label)
  })

  test('patients remain discoverable without redundant map markers, and custody is not inferred from assignment', () => {
    const objects = build()
    objects[1] = update(objects[1]!, { assignment })
    const unit = presentAmbulanceObject(objects[1]!, objects)
    expect(unit.fields?.find(field => field.key === 'on-board')?.value).toBe('0')
    const patient = presentAmbulanceObject(objects[2]!, objects)
    expect(patient.categoryId).toBe('patients')
    expect(patient.mapIconVisible).toBe(false)
    expect(patient.fields?.find(field => field.key === 'holder')?.value).toBe('Test incident')
    expect(ambulancePackView.presentation.categories.find(category => category.id === 'patients')!.matches(objects[2]!)).toBe(true)
    expect(ambulancePackView).not.toHaveProperty('ui')
  })

  test('all four item types are editor-discoverable with required patient reference and no fabricated defaults', () => {
    const catalog = scenarioAuthoringCatalogFor([ambulancePack])
    const types = catalog.packs[0]!.itemTypes
    expect(types.map(type => type.id)).toEqual(['ambulance', 'incident', 'patient', 'care-site'])
    const patient = types.find(type => type.id === 'patient')!
    expect(patient.defaultItem).not.toHaveProperty('incidentId')
    expect(patient.fields.find(field => field.path[0] === 'incidentId')!.optional).toBe(false)
    expect(patient.placement).toBeUndefined()
    const unit = types.find(type => type.id === 'ambulance')!
    expect(unit.fields.find(field => field.path[0] === 'atObject')!.optional).toBe(true)
    expect(unit.fields.find(field => field.path[0] === 'basePosition')!.optional).toBe(true)
    expect(ambulanceItemSchema.safeParse({ ...patient.defaultItem, type: 'patient', id: 'patient:draft', label: 'Draft' }).success).toBe(false)
  })

  test('historian records real types and completed intervals, never synthesized clinical fields or missing-as-zero', () => {
    const objects = build()
    expect(observationsFor(objects[2]!).some(value => value.signalId === 'patient.contactSeconds')).toBe(false)
    const data = patientPackDataSchema.parse(objects[2]!.packData)
    objects[2] = update(objects[2]!, { contactedAtMs: data.createdAtMs + 12_000 })
    expect(observationsFor(objects[2]!).find(value => value.signalId === 'patient.contactSeconds')).toMatchObject({ value: 12, quantity: 'time', unit: 's' })
    const plan = createAmbulanceRecordingPlan({ packId: 'ambulance', profileId: 'operations' })
    const result = plan.sample({ objects, observedAt: at, simulationTime: new Date(start + 30_000).toISOString() as typeof at, elapsedMs: 30_000 })
    expect(result.descriptors.find(series => series.signalId === 'ambulance.crewReady')!.valueType).toBe('boolean')
    expect(result.descriptors.find(series => series.signalId === 'patient.holderId')!.valueType).toBe('string')
    expect(result.descriptors.some(series => /heart|blood|beds|victims/i.test(series.signalId))).toBe(false)
    expect(result.samples.every(sample => sample.observedAt === at && sample.elapsedMs === 30_000)).toBe(true)
  })
})
