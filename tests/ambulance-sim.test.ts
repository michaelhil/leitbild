import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, SessionId } from '../src/core/model/index.ts'
import { geoPointFromLonLat, nowIso, type ObjectId } from '../src/core/model/index.ts'
import {
  assignToIncidentCommandKind,
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../src/domains/ambulance/commands.ts'
import { ambulanceDomainDataSchema, hospitalDomainDataSchema, incidentDomainDataSchema } from '../src/domains/ambulance/model.ts'
import { createOsloAmbulanceScenario } from '../src/domains/ambulance/scenario.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/domains/ambulance/sim/adapter.ts'
import { createAmbulanceSimEngine } from '../src/domains/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const sessionId = 'session:test' as SessionId
const actorId = 'actor:test-operator' as ActorId

const makeCommand = (config: {
  readonly id: string
  readonly kind: string
  readonly targetObjectIds?: ReadonlyArray<ObjectId>
  readonly payload: unknown
  readonly expectedRevision?: number
}): CommandEnvelope => ({
  id: `command:${config.id}` as CommandId,
  sessionId,
  actorId,
  kind: config.kind,
  targetObjectIds: config.targetObjectIds ?? [],
  payload: config.payload,
  issuedAt: nowIso(),
  ...(config.expectedRevision !== undefined ? { expectedRevision: config.expectedRevision } : {}),
})

describe('local ambulance simulator', () => {
  test('starts with one ambulance, one incident, and one hospital', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ sessionId })
    const initial = await connection.getSnapshot()

    expect(initial.objects.filter(object => object.kind === 'mobile_entity')).toHaveLength(1)
    expect(initial.objects.filter(object => object.kind === 'incident')).toHaveLength(1)
    expect(initial.objects.filter(object => object.kind === 'facility')).toHaveLength(1)

    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const hospital = initial.objects.find(object => object.kind === 'facility')
    expect(ambulance?.spatial.position?.point.coordinates).toEqual(hospital?.spatial.position?.point.coordinates)
    expect(ambulanceDomainDataSchema.parse(ambulance?.domainData).capabilities).toContain('advanced_life_support')
    expect(incidentDomainDataSchema.parse(initial.objects.find(object => object.kind === 'incident')?.domainData).victims.count.state).toBe('unknown')
    expect(hospitalDomainDataSchema.parse(hospital?.domainData).emergencyDepartment.diversionStatus.state).toBe('confirmed')
    await connection.close()
  })

  test('accepts a dispatch command and updates scenario state', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ sessionId })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const command = makeCommand({
      id: 'test-dispatch',
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        incidentId: incident.id,
      },
      expectedRevision: ambulance.revision,
    })

    const result = await connection.sendCommand(command)
    expect(result.ok).toBe(true)

    const updated = await connection.getSnapshot()
    const updatedAmbulance = updated.objects.find(object => object.id === ambulance.id)
    const updatedIncident = updated.objects.find(object => object.id === incident.id)
    expect(updatedAmbulance?.operational.status).toBe('assigned')
    expect(updatedAmbulance?.spatial.route?.planned?.coordinates.length).toBeGreaterThanOrEqual(2)
    expect(updatedIncident?.operational.status).toBe('assigned')
    await connection.close()
  })

  test('evolves incident and hospital facts through simulator events', () => {
    const engine = createAmbulanceSimEngine({
      sessionId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    })

    const initialIncident = engine.snapshot().objects.find(object => object.kind === 'incident')
    if (!initialIncident) throw new Error('scenario missing incident')
    expect(incidentDomainDataSchema.parse(initialIncident.domainData).victims.count.state).toBe('unknown')

    const incidentEvents = engine.tick(5_000)
    expect(incidentEvents.some(event => event.type === 'object.upserted' && event.object.kind === 'incident')).toBe(true)
    const revealedIncident = engine.snapshot().objects.find(object => object.kind === 'incident')
    if (!revealedIncident) throw new Error('scenario missing updated incident')
    const incidentData = incidentDomainDataSchema.parse(revealedIncident.domainData)
    expect(incidentData.victims.count.state).toBe('estimated')
    expect(incidentData.victims.injuries.state).toBe('estimated')

    const hospitalEvents = engine.tick(5_000)
    expect(hospitalEvents.some(event => event.type === 'object.upserted' && event.object.kind === 'facility')).toBe(true)
    const hospital = engine.snapshot().objects.find(object => object.kind === 'facility')
    if (!hospital) throw new Error('scenario missing hospital')
    const hospitalData = hospitalDomainDataSchema.parse(hospital.domainData)
    expect(hospitalData.emergencyDepartment.ambulanceBaysAvailable.state).toBe('confirmed')
    if (hospitalData.emergencyDepartment.ambulanceBaysAvailable.state === 'unknown') throw new Error('expected known ambulance bay capacity')
    if (hospitalData.emergencyDepartment.diversionStatus.state === 'unknown') throw new Error('expected known diversion status')
    expect(hospitalData.emergencyDepartment.ambulanceBaysAvailable.value).toBe(1)
    expect(hospitalData.emergencyDepartment.diversionStatus.value).toBe('limited')
  })

  test('creates ambulance domain objects from operator commands', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ sessionId })
    const result = await connection.sendCommand(makeCommand({
      id: 'create-hospital',
      kind: createObjectCommandKind,
      payload: {
        objectType: 'hospital',
        label: 'Ullevål hospital',
        point: geoPointFromLonLat(10.7369, 59.9369),
      },
    }))

    expect(result.ok).toBe(true)
    const updated = await connection.getSnapshot()
    expect(updated.objects.some(object => object.kind === 'facility' && object.label === 'Ullevål hospital')).toBe(true)
    await connection.close()
  })

  test('retargets and cancels an ambulance destination', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ sessionId })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
    const hospital = initial.objects.find(object => object.kind === 'facility')
    if (!ambulance || !incident || !hospital) throw new Error('scenario missing test objects')

    const dispatchResult = await connection.sendCommand(makeCommand({
      id: 'dispatch-before-retarget',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(dispatchResult.ok).toBe(true)

    const retargetResult = await connection.sendCommand(makeCommand({
      id: 'retarget-to-hospital',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, hospital.id],
      payload: { ambulanceId: ambulance.id, destinationId: hospital.id },
    }))
    expect(retargetResult.ok).toBe(true)

    const retargeted = await connection.getSnapshot()
    const retargetedAmbulance = retargeted.objects.find(object => object.id === ambulance.id)
    expect(retargetedAmbulance?.tasking?.currentTaskId).toBe(hospital.id)

    const cancelResult = await connection.sendCommand(makeCommand({
      id: 'cancel-destination',
      kind: cancelDestinationCommandKind,
      targetObjectIds: [ambulance.id],
      payload: { ambulanceId: ambulance.id },
    }))
    expect(cancelResult.ok).toBe(true)

    const cancelled = await connection.getSnapshot()
    const cancelledAmbulance = cancelled.objects.find(object => object.id === ambulance.id)
    expect(cancelledAmbulance?.operational.status).toBe('available')
    expect(cancelledAmbulance?.tasking).toBeUndefined()
    expect(cancelledAmbulance?.spatial.route).toBeUndefined()
    await connection.close()
  })

  test('clears destination when an ambulance reaches a hospital', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ sessionId })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const hospital = initial.objects.find(object => object.kind === 'facility')
    if (!ambulance || !hospital) throw new Error('scenario missing ambulance or hospital')

    const result = await connection.sendCommand(makeCommand({
      id: 'send-to-hospital',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, hospital.id],
      payload: { ambulanceId: ambulance.id, destinationId: hospital.id },
    }))
    expect(result.ok).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 1_050))
    const arrived = await connection.getSnapshot()
    const arrivedAmbulance = arrived.objects.find(object => object.id === ambulance.id)
    expect(arrivedAmbulance?.operational.status).toBe('available')
    expect(arrivedAmbulance?.tasking).toBeUndefined()
    expect(arrivedAmbulance?.spatial.route).toBeUndefined()
    await connection.close()
  })
})
