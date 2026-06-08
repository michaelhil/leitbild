import { describe, expect, test } from 'bun:test'
import type { ActorId, ControlInstanceId, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject, PackId } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import type { PackMapAreaFeature, PackQueryResponse } from '../src/core/packs/protocol.ts'
import { createDroneCommandKind, manualControlPayloadSchema } from '../src/packs/drone/commands.ts'
import { createDroneAttackInteractionHandler, droneAttackSignal } from '../src/packs/drone/interactions.ts'
import {
  defaultDroneVehicleModels,
  dronePackDataSchema,
  dronePackId,
  droneVehicleModelSchema,
  requireDroneVehicleModel,
  type DroneVehicleModel,
} from '../src/packs/drone/model.ts'
import { dronePack } from '../src/packs/drone/pack.ts'
import {
  answerDroneQuery,
  droneControllerBindings,
  droneControllerBindingsQueryKind,
  droneMapFeaturesQueryKind,
  droneSceneObjects,
  droneSceneQueryKind,
  droneSensorContacts,
  droneVehicleModelsQueryKind,
} from '../src/packs/drone/query.ts'
import { droneScenarioSupport } from '../src/packs/drone/scenario.ts'
import { createScenarioDroneObject, withDronePackData } from '../src/packs/drone/sitl/object-state.ts'
import { parseDroneSitlRuntimeConfig } from '../src/packs/drone/sitl/config.ts'
import { droneSitlRuntimeId } from '../src/packs/drone/sitl/constants.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createTestScenarioCatalog } from './helpers.ts'
import { loadDroneWorldTerrainStatus, localPointFromLonLat } from '../src/ui/drone/drone-map-world.ts'

const controlInstanceId = 'control-instance:test-drone-control' as ControlInstanceId
const actorId = 'actor:test-pilot' as ActorId
const at = '2026-06-07T10:00:00.000Z' as IsoTimestamp

const point = (lon: number, lat: number): GeoJsonPoint => geoPointFromLonLat(lon, lat)

const effectModel = (): DroneVehicleModel => droneVehicleModelSchema.parse({
  id: 'px4-x500-effect-test',
  label: 'PX4 X500 Effect Test',
  description: 'PX4 Gazebo X500 test vehicle with declared surveillance and effect payloads.',
  autopilotModel: 'x500',
  gazeboModel: 'x500',
  airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.8, diagonalSizeM: 0.5 },
  capabilities: [
    { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'autopilot' },
    { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'autopilot' },
    { id: 'effect', kind: 'effect_payload', label: 'Effect payload', source: 'payload' },
  ],
  sensors: [
    { id: 'eo-test-camera', kind: 'electro_optical', label: 'EO test camera', rangeM: 900, fovDeg: 70, updateIntervalMs: 100, source: 'gazebo' },
  ],
  payloads: [
    {
      id: 'kinetic-effect',
      kind: 'kinetic_effect',
      label: 'Kinetic effect',
      quantity: 2,
      rangeM: 600,
      source: 'payload',
      effect: { kind: 'kinetic', damage: 0.45, radiusM: 3, cooldownSeconds: 0 },
    },
  ],
  visual: { color: '#991b1b', accentColor: '#fee2e2', scale: 1.12 },
})

const drone = (config: {
  readonly id: string
  readonly label?: string
  readonly model?: DroneVehicleModel
  readonly modelId?: string
  readonly autopilot?: 'px4' | 'ardupilot'
  readonly systemId?: number
  readonly point?: GeoJsonPoint
  readonly altitudeM?: number
  readonly headingDeg?: number
}): OperationalObject => {
  const model = config.model ?? requireDroneVehicleModel(config.modelId ?? 'px4-x500-depth', defaultDroneVehicleModels)
  return createScenarioDroneObject({
    id: config.id as ObjectId,
    label: config.label ?? config.id,
    autopilot: config.autopilot ?? 'px4',
    model,
    point: config.point ?? point(10.75, 59.91),
    altitudeM: config.altitudeM ?? 40,
    headingDeg: config.headingDeg ?? 0,
    at,
    systemId: config.systemId ?? 1,
    endpoint: 'udp://127.0.0.1:14580?localPort=14540',
  })
}

const genericTarget = (config: {
  readonly id: string
  readonly point?: GeoJsonPoint
}): OperationalObject => ({
  id: config.id as ObjectId,
  kind: 'mobile_entity',
  packId: 'ambulance' as PackId,
  label: 'Target ambulance',
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: config.point ?? point(10.7501, 59.91),
      observedAt: at,
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
    createdAt: at,
    updatedAt: at,
  },
})

const okResult = <T>(response: PackQueryResponse): T => {
  if (!response.ok) throw new Error(response.reason)
  return response.result as T
}

describe('drone pack', () => {
  test('expands scenario drones into Gazebo SITL vehicle state without aviation dependencies', async () => {
    const model = effectModel()
    const object = await droneScenarioSupport.expandObject({
      pack: 'drone',
      type: 'drone',
      id: 'drone:scenario-1',
      label: 'Scenario drone',
      position: [10.75, 59.91],
      modelId: model.id,
      altitudeM: 55,
      headingDeg: 37,
      swarm: {
        swarmId: 'swarm:alpha',
        role: 'leader',
        slot: [0, 0, 0],
        separationRadiusM: 10,
      },
    }, {
      at,
      objects: [],
      runtimeConfigs: {
        drone: {
          autopilot: 'px4',
          world: 'oslo',
          mavlink: {
            endpoint: 'udp://127.0.0.1:14580?localPort=14540',
            systemIdBase: 42,
          },
          models: [model],
        },
      },
      objectById: () => undefined,
      routing: createDirectRoutingAdapter(),
    })

    const data = dronePackDataSchema.parse(object.packData)
    expect(object.packId).toBe(dronePackId as PackId)
    expect(data.schemaVersion).toBe(2)
    expect(data.autopilot).toBe('px4')
    expect(data.vehicle.modelId).toBe(model.id)
    expect(data.vehicle.systemId).toBe(42)
    expect(data.link).toMatchObject({
      state: 'connecting',
      endpoint: 'udp://127.0.0.1:14580?localPort=14540',
    })
    expect(data.pose.altitudeM).toBe(55)
    expect(data.pose.headingDeg).toBe(37)
    expect(data.swarm?.swarmId).toBe('swarm:alpha')
  })

  test('assigns MAVLink system ids from scenario config across multiple drones', async () => {
    const first = drone({ id: 'drone:first', systemId: 8 })
    const second = await droneScenarioSupport.expandObject({
      pack: 'drone',
      type: 'drone',
      id: 'drone:second',
      label: 'Second drone',
      position: [10.751, 59.91],
      modelId: 'px4-x500-depth',
    }, {
      at,
      objects: [first],
      runtimeConfigs: {
        drone: {
          mavlink: { systemIdBase: 8 },
        },
      },
      objectById: (id) => id === first.id ? first : undefined,
      routing: createDirectRoutingAdapter(),
    })

    const data = dronePackDataSchema.parse(second.packData)
    expect(data.vehicle.systemId).toBe(9)
  })

  test('SITL runtime parser accepts scenario vehicle system id metadata separately from client source ids', () => {
    const parsed = parseDroneSitlRuntimeConfig({
      mavlink: {
        endpoint: 'udp://127.0.0.1:14580?localPort=14540',
        systemIdBase: 8,
        sourceSystemId: 245,
        sourceComponentId: 190,
      },
    }, {})

    expect(parsed.endpointText).toBe('udp://127.0.0.1:14580?localPort=14540')
    expect(parsed.endpoint.port).toBe(14580)
    expect(parsed.endpoint.localPort).toBe(14540)
    expect(parsed.sourceSystemId).toBe(245)
    expect(parsed.sourceComponentId).toBe(190)
  })

  test('SITL runtime parser rejects loopback endpoints that would receive Leitbild heartbeats from itself', () => {
    expect(() => parseDroneSitlRuntimeConfig({
      mavlink: {
        endpoint: 'udp://127.0.0.1:14540',
      },
    }, {})).toThrow('loopback remote port must differ from localPort')
  })

  test('scene projection uses canonical SITL telemetry fields', () => {
    const objects = [
      drone({ id: 'drone:scene-1', altitudeM: 35, headingDeg: 25 }),
      drone({ id: 'drone:scene-2', modelId: 'px4-x500-gimbal', systemId: 2 }),
    ]
    const scene = droneSceneObjects(objects)
    expect(scene.map(item => item.id)).toEqual(['drone:scene-1' as ObjectId, 'drone:scene-2' as ObjectId])
    expect(scene[0]).toMatchObject({
      altitudeM: 35,
      headingDeg: 25,
      modelId: 'px4-x500-depth',
      link: 'connecting',
      armed: false,
    })
    expect(scene[1]?.modelId).toBe('px4-x500-gimbal')
  })

  test('SITL telemetry stream can be connected before heartbeat-derived arming is known', () => {
    const object = drone({ id: 'drone:telemetry-stream' })
    const data = dronePackDataSchema.parse(object.packData)
    const updated = withDronePackData(object, {
      ...data,
      link: {
        ...data.link,
        state: 'connected',
        lastMessageAt: at,
      },
      arming: {
        state: 'unknown',
        armed: false,
      },
      pose: {
        ...data.pose,
        observedAt: at,
      },
    }, at)
    const updatedData = dronePackDataSchema.parse(updated.packData)

    expect(updated.operational.status).toBe('telemetry_connected')
    expect(updated.communication?.state).toBe('connected')
    expect(updatedData.arming.state).toBe('unknown')
    expect(updatedData.link.lastMessageAt).toBe(at)
  })

  test('controller bindings are derived from drone control state only', () => {
    const object = drone({ id: 'drone:bound' })
    const data = dronePackDataSchema.parse(object.packData)
    const updated = withDronePackData(object, {
      ...data,
      control: {
        pilotActorId: actorId,
        inputSource: { kind: 'mouse', label: 'Pointer lock' },
        inputExpiresAt: '2026-06-07T10:00:01.000Z' as IsoTimestamp,
      },
    }, at)

    const bindings = droneControllerBindings([updated])
    expect(bindings).toEqual([{
      droneId: object.id,
      actorId,
      inputKind: 'mouse',
      label: 'Pointer lock',
      inputExpiresAt: '2026-06-07T10:00:01.000Z' as IsoTimestamp,
    }])
  })

  test('map features come from vehicle sensors, payloads, and swarm metadata', () => {
    const object = drone({ id: 'drone:features', model: effectModel() })
    const data = dronePackDataSchema.parse(object.packData)
    const swarmed = withDronePackData(object, {
      ...data,
      swarm: {
        swarmId: 'swarm:test',
        role: 'member',
        slot: [0, 0, 0],
        separationRadiusM: 12,
      },
    }, at)
    const response = answerDroneQuery({
      request: {
        packId: dronePackId,
        kind: droneMapFeaturesQueryKind,
        payload: {
          layers: ['sensor-footprints', 'effect-ranges', 'swarm-envelopes'],
        },
      },
      objects: [swarmed],
      at,
    })

    const result = okResult<{ readonly features: ReadonlyArray<PackMapAreaFeature> }>(response)
    expect(result.features.map(feature => feature.id)).toEqual([
      'drone:features:sensor-footprint',
      'drone:features:effect-range',
      'drone:features:swarm-envelope',
    ])
    expect(result.features[0]?.geometry.type).toBe('Polygon')
  })

  test('vehicle model queries expose the configured model catalog', () => {
    const model = effectModel()
    const response = answerDroneQuery({
      request: {
        packId: dronePackId,
        kind: droneVehicleModelsQueryKind,
        payload: {},
      },
      objects: [],
      at,
      models: [model],
    })
    const result = okResult<{ readonly models: ReadonlyArray<DroneVehicleModel> }>(response)
    expect(result.models).toEqual([model])
  })

  test('scene and binding pack queries use one typed query surface', () => {
    const object = drone({ id: 'drone:query' })
    const scene = okResult<{ readonly drones: ReturnType<typeof droneSceneObjects> }>(answerDroneQuery({
      request: { packId: dronePackId, kind: droneSceneQueryKind, payload: {} },
      objects: [object],
      at,
    }))
    const bindings = okResult<{ readonly bindings: ReturnType<typeof droneControllerBindings> }>(answerDroneQuery({
      request: { packId: dronePackId, kind: droneControllerBindingsQueryKind, payload: {} },
      objects: [object],
      at,
    }))

    expect(scene.drones).toHaveLength(1)
    expect(bindings.bindings).toHaveLength(1)
  })

  test('sensor contacts are not fabricated by the browser-side query layer', () => {
    const observer = drone({ id: 'drone:observer', modelId: 'px4-x500-gimbal' })
    const target = genericTarget({ id: 'amb:visible-target', point: point(10.75, 59.911) })
    expect(droneSensorContacts([observer, target])).toEqual([])
  })

  test('manual control accepts mouse as a first-class input source', () => {
    const parsed = manualControlPayloadSchema.parse({
      droneId: 'drone:mouse-controlled',
      axes: { forward: 0.4, right: 0, vertical: 0.1, yaw: -0.2 },
      inputSource: { kind: 'mouse', label: 'Mouse pointer lock' },
      commandTtlMs: 650,
    })
    expect(parsed.inputSource.kind).toBe('mouse')
    expect(parsed.axes.forward).toBe(0.4)
  })

  test('attack effects deplete declared payloads and damage targets through interaction handlers', async () => {
    const attacker = drone({ id: 'drone:attacker', model: effectModel() })
    const target = genericTarget({ id: 'amb:drone-target' })
    const handler = createDroneAttackInteractionHandler()
    const signal = droneAttackSignal({
      controlInstanceId,
      at,
      attackerId: attacker.id,
      targetId: target.id,
      payloadId: 'kinetic-effect',
    })

    const effects = await handler.handle({
      signal,
      snapshot: { objects: [attacker, target], seq: 1 },
      provenance: { source: 'simulator' },
    })
    const upserts = effects.flatMap(effect => effect.type === 'object.upsert' ? [effect.object] : [])
    const updatedAttacker = upserts.find(object => object.id === attacker.id)
    const updatedTarget = upserts.find(object => object.id === target.id)

    if (!updatedAttacker || !updatedTarget) throw new Error('missing drone attack upsert effects')
    const attackerData = dronePackDataSchema.parse(updatedAttacker.packData)
    expect(attackerData.vehicle.payloads.find(payload => payload.id === 'kinetic-effect')?.quantity).toBe(1)
    expect(updatedTarget.operational.status).toBe('damaged')
    expect(updatedTarget.alerts.some(alert => alert.kind === 'drone_effect')).toBe(true)
  })

  test('drone pack presentation and creation commands expose SITL vehicle concepts', () => {
    const object = drone({ id: 'drone:presentation', modelId: 'px4-x500-gimbal' })
    const presentation = dronePack.presentObject(object, { objects: [object] })
    const fieldsByKey = new Map(presentation.fields.map(field => [field.key, field.value]))
    expect(fieldsByKey.get('autopilot')).toBe('px4')
    expect(fieldsByKey.get('model')).toBe('PX4 X500 Gimbal')
    expect(fieldsByKey.get('link')).toBe('connecting')

    const command = dronePack.buildCreateObjectCommand('drone', 'New SITL drone', {
      kind: 'point',
      point: point(10.77, 59.92),
    }, {
      modelId: 'px4-x500-gimbal',
      altitudeM: 65,
    })
    expect(command).toMatchObject({
      kind: createDroneCommandKind,
      payload: {
        objectType: 'drone',
        label: 'New SITL drone',
        modelId: 'px4-x500-gimbal',
        altitudeM: 65,
      },
    })
  })

  test('drone map world projection keeps east positive x and north negative z', () => {
    const center = { lon: 10.75, lat: 59.91 }
    const east = localPointFromLonLat(10.7501, 59.91, center)
    const north = localPointFromLonLat(10.75, 59.9101, center)
    expect(east.x).toBeGreaterThan(5)
    expect(Math.abs(east.z)).toBeLessThan(0.01)
    expect(north.z).toBeLessThan(-10)
    expect(Math.abs(north.x)).toBeLessThan(0.01)
  })

  test('drone terrain status reflects the map capability manifest without fabricating elevation', async () => {
    const originalFetch = globalThis.fetch
    const mockFetch = (body: unknown): typeof fetch => {
      const handler = async (): Promise<Response> => new Response(JSON.stringify(body))
      return Object.assign(handler, { preconnect: originalFetch.preconnect }) as typeof fetch
    }
    try {
      globalThis.fetch = mockFetch({
        schemaVersion: 2,
        tilesets: [{
          kind: 'terrain',
          availability: {
            status: 'available',
            path: '/opt/leitbild/maps/current/terrain.pmtiles',
          },
          artifact: {
            demEncoding: 'terrarium',
            currentTileTemplate: '/map/terrain/current/{z}/{x}/{y}.png',
            tileJsonUrl: '/map/terrain/current/tiles.json',
          },
        }],
      })
      const available = await loadDroneWorldTerrainStatus()
      expect(available).toMatchObject({
        status: 'available',
        demEncoding: 'terrarium',
        tileTemplate: '/map/terrain/current/{z}/{x}/{y}.png',
      })

      globalThis.fetch = mockFetch({
        schemaVersion: 2,
        tilesets: [{
          kind: 'terrain',
          availability: {
            status: 'unavailable',
            error: 'ENOENT terrain.pmtiles',
          },
          artifact: {
            demEncoding: 'terrarium',
            currentTileTemplate: '/map/terrain/current/{z}/{x}/{y}.png',
            tileJsonUrl: '/map/terrain/current/tiles.json',
          },
        }],
      })
      const unavailable = await loadDroneWorldTerrainStatus()
      expect(unavailable).toMatchObject({
        status: 'unavailable',
        reason: 'ENOENT terrain.pmtiles',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('built-in drone scenario and mission resolve through the Gazebo SITL runtime', () => {
    const catalog = createTestScenarioCatalog()
    const scenario = catalog.getScenario('oslo-drone-operations')
    if (!scenario?.missionId) throw new Error('missing drone scenario mission')
    const mission = catalog.getMission(scenario.missionId)
    const runtime = catalog.runtimeFor(scenario.id)
    if (!runtime) throw new Error('missing drone runtime')
    const droneRuntime = runtime.runtimes.find(entry => entry.packId === dronePackId)
    const droneObjects = runtime.initialObjects.filter(object => object.packId === dronePackId)
    const firstDroneData = dronePackDataSchema.parse(droneObjects[0]?.packData)

    expect(mission?.scenarioId).toBe(scenario.id)
    expect(droneRuntime?.runtimeId).toBe(droneSitlRuntimeId)
    expect(droneObjects.length).toBeGreaterThan(0)
    expect(firstDroneData.schemaVersion).toBe(2)
    expect(firstDroneData.link.endpoint).toBe('udp://127.0.0.1:14580?localPort=14540')
    expect('profile' in firstDroneData).toBe(false)
    expect('kinematics' in firstDroneData).toBe(false)
    expect('energy' in firstDroneData).toBe(false)
  })
})
