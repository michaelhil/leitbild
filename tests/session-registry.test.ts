import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ActorId, CommandEnvelope, CommandId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createSessionRegistry } from '../src/core/sessions/registry.ts'
import { assignToIncidentCommandKind } from '../src/domains/ambulance/commands.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/domains/ambulance/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

describe('session registry', () => {
  test('keeps object state scoped to the created session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const registry = createSessionRegistry({
      dataDir,
      simulationAdapter: createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
    })
    const session = await registry.create()
    const snapshot = session.snapshot()
    const ambulance = snapshot.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = snapshot.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const command: CommandEnvelope = {
      id: 'command:test-session-dispatch' as CommandId,
      sessionId: session.id,
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

    const result = await session.issueCommand({
      id: command.actorId,
      label: 'Test Operator',
      role: 'operator',
    }, command)
    expect(result.ok).toBe(true)
    expect(session.snapshot().objects.find(object => object.id === ambulance.id)?.operational.status).toBe('assigned')
    await session.close()
  })
})
