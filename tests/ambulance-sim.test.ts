import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, SessionId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { assignToIncidentCommandKind } from '../src/domains/ambulance/commands.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/domains/ambulance/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

describe('local ambulance simulator', () => {
  test('accepts a dispatch command and updates scenario state', async () => {
    const sessionId = 'session:test' as SessionId
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ sessionId })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const command: CommandEnvelope = {
      id: 'command:test-dispatch' as CommandId,
      sessionId,
      actorId: 'actor:test-operator' as ActorId,
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        incidentId: incident.id,
      },
      issuedAt: nowIso(),
      expectedRevision: ambulance.revision,
    }

    const result = await connection.sendCommand(command)
    expect(result.ok).toBe(true)

    const updated = await connection.getSnapshot()
    const updatedAmbulance = updated.objects.find(object => object.id === ambulance.id)
    const updatedIncident = updated.objects.find(object => object.id === incident.id)
    expect(updatedAmbulance?.operational.status).toBe('assigned')
    expect(updatedIncident?.operational.status).toBe('assigned')
    await connection.close()
  })
})
