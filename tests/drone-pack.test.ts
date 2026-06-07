import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, GeoJsonPoint, ObjectId, OperationalObject, PackId } from '../src/core/model/index.ts'
import { geoPointFromLonLat, meters, nowIso } from '../src/core/model/index.ts'
import { leitbildPacks } from '../src/app-assembly.ts'
import { createScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { attackCommandKind, manualControlCommandKind, swarmCommandKind } from '../src/packs/drone/commands.ts'
import { createDroneAttackInteractionHandler, droneAttackSignal } from '../src/packs/drone/interactions.ts'
import { defaultDroneProfiles, dronePackDataSchema, requireDroneProfile } from '../src/packs/drone/model.ts'
import { droneSceneObjects, droneSensorContacts } from '../src/packs/drone/query.ts'
import { droneEnvironmentFromRuntimeConfigValue, droneScenarioSupport } from '../src/packs/drone/scenario.ts'
import { droneSimRuntimeId } from '../src/packs/drone/sim/constants.ts'
import { createDroneSimEngine } from '../src/packs/drone/sim/engine.ts'
import { createScenarioDroneObject } from '../src/packs/drone/sim/object-state.ts'
import { builtinMissions, scenarios } from '../src/scenarios/index.ts'

const controlInstanceId = 'test-drone-control' as ControlInstanceId
const actorId = 'actor:test-pilot' as ActorId

const command = (kind: string, payload: unknown, targetObjectIds: ReadonlyArray<ObjectId> = []): CommandEnvelope => ({
  id: `command:${kind}:${Math.random().toString(36).slice(2)}` as CommandId,
  controlInstanceId,
  actorId,
  kind,
  targetObjectIds,
  payload,
  issuedAt: nowIso(),
})

const point = (lon: number, lat: number): GeoJsonPoint => geoPointFromLonLat(lon, lat)

const drone = (config: {
  readonly id: string
  readonly profileId?: string
  readonly point?: GeoJsonPoint
  readonly altitudeM?: number
}): OperationalObject =>
  createScenarioDroneObject({
    id: config.id as ObjectId,
    label: config.id,
    point: config.point ?? point(10.75, 59.91),
    profile: requireDroneProfile(config.profileId ?? 'quad-surveillance'),
    altitudeM: config.altitudeM ?? 40,
    headingDeg: 0,
    at: nowIso(),
    mode: 'hold',
  })

describe('drone pack', () => {
  test('expands configurable drone scenario objects without aviation dependencies', async () => {
    const object = await droneScenarioSupport.expandObject({
      pack: 'drone',
      type: 'drone',
      id: 'drone:scenario-1',
      label: 'Scenario drone',
      position: [10.75, 59.91],
      profile: {
        ...defaultDroneProfiles[0]!,
        id: 'scenario-custom-surveillance',
        label: 'Scenario custom surveillance',
        dynamics: {
          ...defaultDroneProfiles[0]!.dynamics,
          maxHorizontalSpeedMps: 22,
        },
      },
      altitudeM: 55,
      swarm: {
        swarmId: 'swarm:alpha',
        role: 'leader',
        slot: [0, 0, 0],
        separationRadiusM: 10,
      },
    }, {
      at: nowIso(),
      objects: [],
      runtimeConfigs: {},
      objectById: () => undefined,
      routing: {
        id: 'test-routing',
        route: async ({ from, to }) => ({
          geometry: { type: 'LineString', coordinates: [from.coordinates, to.coordinates] },
          distanceM: meters(1),
          durationSeconds: 1,
          provider: 'test',
        }),
      },
    })
    const data = dronePackDataSchema.parse(object.packData)
    expect(object.packId).toBe('drone' as PackId)
    expect(data.profile.id).toBe('scenario-custom-surveillance')
    expect(data.kinematics.altitudeM).toBe(55)
    expect(data.swarm?.swarmId).toBe('swarm:alpha')
  })

  test('manual control moves one drone without moving another drone', async () => {
    const controlled = drone({ id: 'drone:controlled', point: point(10.75, 59.91) })
    const idle = drone({ id: 'drone:idle', point: point(10.751, 59.91) })
    const engine = createDroneSimEngine({
      controlInstanceId,
      objects: [controlled, idle],
    })
    const result = await engine.handleCommand(command(manualControlCommandKind, {
      droneId: controlled.id,
      axes: { forward: 1, right: 0, vertical: 0.2, yaw: 0.1 },
      inputSource: { kind: 'keyboard', label: 'test keyboard' },
      commandTtlMs: 2_000,
    }, [controlled.id]))
    expect(result.result.ok).toBe(true)
    const events = engine.tick(1_000, new Date(Date.now() + 1_000).toISOString() as never)
    expect(events.some(event => event.type === 'object.upserted' && event.object.id === controlled.id)).toBe(true)
    const snapshot = engine.snapshot()
    const moved = snapshot.objects.find(object => object.id === controlled.id)!
    const unmoved = snapshot.objects.find(object => object.id === idle.id)!
    expect(moved.spatial.position?.point.coordinates[1]).toBeGreaterThan(controlled.spatial.position!.point.coordinates[1])
    expect(unmoved.spatial.position?.point.coordinates).toEqual(idle.spatial.position?.point.coordinates)
    const movedData = dronePackDataSchema.parse(moved.packData)
    expect(movedData.energy.remainingWh).toBeLessThan(movedData.profile.energy.capacityWh)
  })

  test('runtime environment config is applied to physics and drone pack data', () => {
    const environment = droneEnvironmentFromRuntimeConfigValue({
      environment: {
        windSpeedMps: 12,
        windDirectionDeg: 90,
        gustSpeedMps: 4,
        turbulenceIntensity: 0.4,
        precipitation: 'rain',
        precipitationIntensity: 0.3,
        visibilityM: 4_000,
        airDensityKgM3: 1.2,
      },
    })
    const at = '2026-06-07T10:00:00.000Z' as never
    const calmEngine = createDroneSimEngine({
      controlInstanceId,
      objects: [drone({ id: 'drone:calm', point: point(10.75, 59.91) })],
      startedAt: at,
    })
    const windyEngine = createDroneSimEngine({
      controlInstanceId,
      objects: [drone({ id: 'drone:windy', point: point(10.75, 59.91) })],
      environment,
      startedAt: at,
    })
    calmEngine.tick(1_000, '2026-06-07T10:00:01.000Z' as never)
    windyEngine.tick(1_000, '2026-06-07T10:00:01.000Z' as never)
    const calmData = dronePackDataSchema.parse(calmEngine.snapshot().objects[0]!.packData)
    const windyData = dronePackDataSchema.parse(windyEngine.snapshot().objects[0]!.packData)
    expect(windyData.environment.windSpeedMps).toBe(12)
    expect(windyData.energy.remainingWh).toBeLessThan(calmData.energy.remainingWh)
    expect(Math.abs(windyData.kinematics.rollDeg)).toBeGreaterThan(0)
  })

  test('manual diagonal control respects the profile horizontal speed envelope', async () => {
    const controlled = drone({ id: 'drone:diagonal-limit', point: point(10.75, 59.91) })
    const engine = createDroneSimEngine({
      controlInstanceId,
      objects: [controlled],
    })
    const result = await engine.handleCommand(command(manualControlCommandKind, {
      droneId: controlled.id,
      axes: { forward: 1, right: 1, vertical: 0, yaw: 0 },
      inputSource: { kind: 'keyboard', label: 'test keyboard' },
      commandTtlMs: 5_000,
    }, [controlled.id]))
    expect(result.result.ok).toBe(true)
    engine.tick(5_000, '2026-06-07T10:00:05.000Z' as never)
    const data = dronePackDataSchema.parse(engine.snapshot().objects[0]!.packData)
    const speedMps = Math.hypot(data.kinematics.velocityEastMps, data.kinematics.velocityNorthMps)
    expect(speedMps).toBeLessThanOrEqual(data.profile.dynamics.maxHorizontalSpeedMps + 0.0001)
  })

  test('swarm commands keep each drone as an individual simulated object', async () => {
    const drones = [
      drone({ id: 'drone:swarm-1', point: point(10.75, 59.91) }),
      drone({ id: 'drone:swarm-2', point: point(10.7502, 59.91) }),
      drone({ id: 'drone:swarm-3', point: point(10.7504, 59.91) }),
    ]
    const engine = createDroneSimEngine({ controlInstanceId, objects: drones })
    const result = await engine.handleCommand(command(swarmCommandKind, {
      swarmId: 'swarm:test',
      droneIds: drones.map(item => item.id),
      command: {
        kind: 'navigate',
        target: { point: point(10.752, 59.913), altitudeM: 70 },
        formation: { kind: 'grid', spacingM: 20, altitudeStepM: 3 },
      },
    }, drones.map(item => item.id)))
    expect(result.result.ok).toBe(true)
    engine.tick(1_000, new Date(Date.now() + 1_000).toISOString() as never)
    const snapshot = engine.snapshot()
    expect(snapshot.objects).toHaveLength(3)
    expect(new Set(snapshot.objects.map(object => object.id)).size).toBe(3)
    for (const object of snapshot.objects) {
      const data = dronePackDataSchema.parse(object.packData)
      expect(data.control.mode).toBe('swarm')
      expect(data.swarm?.swarmId).toBe('swarm:test')
    }
  })

  test('attack effects can damage non-drone operational assets through interaction handlers', async () => {
    const attacker = drone({ id: 'drone:attacker', profileId: 'interceptor-effect', point: point(10.75, 59.91) })
    const target: OperationalObject = {
      id: 'ambulance:target' as ObjectId,
      kind: 'mobile_entity',
      packId: 'ambulance' as PackId,
      label: 'Target ambulance',
      lifecycle: 'active',
      revision: 0,
      spatial: {
        position: {
          point: point(10.7501, 59.91),
          observedAt: nowIso(),
        },
        frame: { kind: 'wgs84' },
      },
      operational: {
        status: 'available',
        priority: 'normal',
        mode: 'simulated',
      },
      alerts: [],
      provenance: {
        source: 'simulator',
      },
      timestamps: {
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    }
    const handler = createDroneAttackInteractionHandler()
    const signal = droneAttackSignal({
      controlInstanceId,
      at: nowIso(),
      attackerId: attacker.id,
      targetId: target.id,
      payloadId: 'kinetic-effect',
    })
    const effects = await handler.handle({
      signal,
      snapshot: { objects: [attacker, target], seq: 1 },
      provenance: { source: 'simulator' },
    })
    const updatedTarget = effects.find(effect => effect.type === 'object.upsert' && effect.object.id === target.id)
    expect(updatedTarget?.type).toBe('object.upsert')
    if (updatedTarget?.type !== 'object.upsert') throw new Error('missing updated target')
    expect(updatedTarget.object.operational.status).toBe('damaged')
    expect(updatedTarget.object.alerts.some(alert => alert.kind === 'drone_effect')).toBe(true)
  })

  test('scene projection exposes one entry per drone', () => {
    const objects = [
      drone({ id: 'drone:scene-1' }),
      drone({ id: 'drone:scene-2', profileId: 'heavy-supply' }),
    ]
    const scene = droneSceneObjects(objects)
    expect(scene.map(item => item.id)).toEqual(['drone:scene-1' as ObjectId, 'drone:scene-2' as ObjectId])
    expect(scene[1]?.profileId).toBe('heavy-supply')
  })

  test('sensor contacts are read-only surveillance projections with field-of-view filtering', () => {
    const observer = drone({ id: 'drone:observer', point: point(10.75, 59.91) })
    const targetAhead: OperationalObject = {
      id: 'amb:visible-target' as ObjectId,
      kind: 'mobile_entity',
      packId: 'ambulance' as PackId,
      label: 'Visible target',
      lifecycle: 'active',
      revision: 0,
      spatial: {
        position: {
          point: point(10.75, 59.911),
          observedAt: nowIso(),
        },
        frame: { kind: 'wgs84' },
      },
      operational: { status: 'available', priority: 'normal', mode: 'simulated' },
      alerts: [],
      provenance: { source: 'simulator' },
      timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
    }
    const targetBehind: OperationalObject = {
      ...targetAhead,
      id: 'amb:hidden-target' as ObjectId,
      label: 'Hidden target',
      spatial: {
        ...targetAhead.spatial,
        position: {
          point: point(10.75, 59.909),
          observedAt: nowIso(),
        },
      },
    }
    const contacts = droneSensorContacts([observer, targetAhead, targetBehind])
    expect(contacts.some(contact => contact.targetId === targetAhead.id)).toBe(true)
    expect(contacts.some(contact => contact.targetId === targetBehind.id)).toBe(false)
    expect(contacts[0]?.confidence).toBeGreaterThan(0)
  })

  test('runtime rejects attack commands from non-existent drones explicitly', async () => {
    const engine = createDroneSimEngine({ controlInstanceId, objects: [] })
    const handled = await engine.handleCommand(command(attackCommandKind, {
      attackerId: 'drone:missing',
      targetId: 'ambulance:target',
    }))
    expect(handled.result.ok).toBe(false)
    expect(handled.result.ok ? '' : handled.result.reason).toContain('unknown drone')
  })

  test('built-in drone scenario and mission are catalog-valid together', () => {
    const catalog = createScenarioCatalog({ packs: leitbildPacks, scenarios, missions: builtinMissions })
    const scenario = catalog.getScenario('oslo-drone-operations')
    if (!scenario?.missionId) throw new Error('missing drone scenario mission')
    const mission = catalog.getMission(scenario.missionId)
    const runtime = catalog.runtimeFor(scenario.id)

    expect(mission?.scenarioId).toBe(scenario.id)
    expect(runtime?.runtimes.some(entry => entry.runtimeId === droneSimRuntimeId)).toBe(true)
    expect(runtime?.initialObjects.filter(object => object.packId === 'drone').length).toBeGreaterThan(0)
  })
})
