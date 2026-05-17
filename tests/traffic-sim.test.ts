import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId } from '../src/core/model/index.ts'
import { geoPointFromLonLat, nowIso } from '../src/core/model/index.ts'
import { createTrafficConditionCommandKind } from '../src/packs/traffic/commands.ts'
import { trafficDomainDataSchema } from '../src/packs/traffic/model.ts'
import { trafficConditionChangedSignalType } from '../src/packs/traffic/interactions.ts'
import { createLocalTrafficSimulationAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const controlInstanceId = 'control-instance:traffic-sim-test' as ControlInstanceId

const makeCommand = (payload: unknown): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  controlInstanceId,
  actorId: 'actor:test-operator' as ActorId,
  kind: createTrafficConditionCommandKind,
  targetObjectIds: [],
  payload,
  issuedAt: nowIso(),
})

describe('local traffic simulator', () => {
  test('rejects previous traffic condition data instead of migrating it silently', () => {
    expect(() => trafficDomainDataSchema.parse({
      type: 'traffic_condition',
      schemaVersion: 1,
      condition: 'slowdown',
      severity: 'high',
      affectedModes: ['road_vehicle', 'emergency_vehicle'],
      speedFactor: 0.55,
      reason: {
        state: 'confirmed',
        value: 'Existing slowdown',
        confidence: 1,
        updatedAt: nowIso(),
        source: 'simulation',
      },
      startsAt: nowIso(),
    })).toThrow()
  })

  test('creates road-segment traffic from routed start and end points', async () => {
    const adapter = createLocalTrafficSimulationAdapter({ routing: createDirectRoutingAdapter() })
    const connection = await adapter.connect({ controlInstanceId })
    try {
      const emittedTypes: string[] = []
      const unsubscribe = connection.subscribe(emission => {
        for (const event of emission.events) {
          if (event.type === 'interaction.signal') emittedTypes.push(event.signal.type)
        }
      })
      const result = await connection.sendCommand(makeCommand({
        objectType: 'traffic_road_segment',
        label: 'Operator road slowdown',
        from: geoPointFromLonLat(10.70, 59.90),
        to: geoPointFromLonLat(10.72, 59.91),
        severity: 'high',
        speedFactor: 0.4,
        reason: 'Queue spillback',
      }))

      expect(result.ok).toBe(true)
      const object = (await connection.getSnapshot()).objects.find(candidate => candidate.label === 'Operator road slowdown')
      if (!object) throw new Error('traffic object was not created')
      const data = trafficDomainDataSchema.parse(object.domainData)

      expect(object.spatial.geometry?.type).toBe('LineString')
      expect(data.geometryMode).toBe('road_segment')
      expect(data.speedFactor).toBe(0.4)
      expect(data.reason.state === 'confirmed' ? data.reason.value : null).toBe('Queue spillback')
      expect(emittedTypes).toContain(trafficConditionChangedSignalType)
      unsubscribe()
    } finally {
      await connection.close()
    }
  })

  test('creates area traffic from a polygon', async () => {
    const adapter = createLocalTrafficSimulationAdapter()
    const connection = await adapter.connect({ controlInstanceId })
    try {
      const result = await connection.sendCommand(makeCommand({
        objectType: 'traffic_area',
        label: 'Operator area slowdown',
        polygon: {
          type: 'Polygon',
          coordinates: [[
            geoPointFromLonLat(10.70, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.92).coordinates,
            geoPointFromLonLat(10.70, 59.90).coordinates,
          ]],
        },
        severity: 'moderate',
        speedFactor: 0.65,
        reason: 'Event crowding',
      }))

      expect(result.ok).toBe(true)
      const object = (await connection.getSnapshot()).objects.find(candidate => candidate.label === 'Operator area slowdown')
      if (!object) throw new Error('traffic object was not created')
      const data = trafficDomainDataSchema.parse(object.domainData)

      expect(object.spatial.geometry?.type).toBe('Polygon')
      expect(data.geometryMode).toBe('area')
      expect(data.severity).toBe('moderate')
      expect(data.reason.state === 'confirmed' ? data.reason.value : null).toBe('Event crowding')
    } finally {
      await connection.close()
    }
  })
})
