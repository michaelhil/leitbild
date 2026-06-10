import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, ControlInstanceId, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject, PackId } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import type { PackQueryResponse } from '../src/core/packs/protocol.ts'
import {
  armDroneCommandKind,
  createDroneCommandKind,
  holdDroneCommandKind,
  manualControlCommandKind,
  navigateDroneCommandKind,
  takeoffDroneCommandKind,
} from '../src/packs/drone/commands.ts'
import { droneManualControlReadiness } from '../src/packs/drone/control-readiness.ts'
import { createDroneAttackInteractionHandler, droneAttackSignal } from '../src/packs/drone/interactions.ts'
import {
  defaultDroneVehicleModels,
  dronePackDataSchema,
  dronePackId,
  droneVehicleModelSchema,
  requireDroneVehicleModel,
  type DroneVehicleModel,
} from '../src/packs/drone/model.ts'
import { createDroneNativePackRuntimeAdapter } from '../src/packs/drone/native/adapter.ts'
import { parseDroneNativeRuntimeConfig } from '../src/packs/drone/native/config.ts'
import { droneNativeRuntimeId } from '../src/packs/drone/native/constants.ts'
import { createScenarioDroneObject, withDronePackData } from '../src/packs/drone/native/object-state.ts'
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
import { babylonYawRadForHeadingDeg, bodyVelocityInBabylonFrame, horizontalVelocityFromBabylonBodyFrame } from '../src/packs/drone/spatial.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { loadDroneWorldTerrainStatus, localPointFromLonLat } from '../src/ui/drone/drone-map-world.ts'
import { createTestScenarioCatalog, waitForCondition } from './helpers.ts'

const controlInstanceId = 'control-instance:test-drone-control' as ControlInstanceId
const actorId = 'actor:test-pilot' as ActorId
const at = '2026-06-07T10:00:00.000Z' as IsoTimestamp

const point = (lon: number, lat: number): GeoJsonPoint => geoPointFromLonLat(lon, lat)

const effectModel = (): DroneVehicleModel => droneVehicleModelSchema.parse({
  id: 'native-effect-test',
  label: 'Native Effect Test',
  description: 'Native test vehicle with declared surveillance and effect payloads.',
  airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.8, diagonalSizeM: 0.5 },
  flightEnvelope: {
    cruiseSpeedMps: 22,
    maxHorizontalSpeedMps: 44,
    maxVerticalSpeedMps: 10,
    maxAccelerationMps2: 16,
    maxYawRateDegPerSec: 160,
    arrivalRadiusM: 4,
  },
  capabilities: [
    { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'runtime' },
    { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'runtime' },
    { id: 'effect', kind: 'effect_payload', label: 'Effect payload', source: 'payload' },
  ],
  sensors: [
    { id: 'eo-test-camera', kind: 'electro_optical', label: 'EO test camera', rangeM: 900, fovDeg: 70, updateIntervalMs: 100, source: 'payload' },
  ],
  payloads: [
    {
      id: 'training-effect',
      kind: 'training_effect',
      label: 'Training effect',
      quantity: 2,
      rangeM: 600,
      source: 'payload',
      effect: { kind: 'training', damage: 0.45, radiusM: 3, cooldownSeconds: 0 },
    },
  ],
  visual: { color: '#991b1b', accentColor: '#fee2e2', scale: 1.12 },
})

const drone = (config: {
  readonly id: string
  readonly label?: string
  readonly model?: DroneVehicleModel
  readonly modelId?: string
  readonly point?: GeoJsonPoint
  readonly altitudeM?: number
  readonly headingDeg?: number
}): OperationalObject => {
  const model = config.model ?? requireDroneVehicleModel(config.modelId ?? 'native-survey-quad', defaultDroneVehicleModels)
  return createScenarioDroneObject({
    id: config.id as ObjectId,
    label: config.label ?? config.id,
    model,
    point: config.point ?? point(10.75, 59.91),
    altitudeM: config.altitudeM ?? 40,
    headingDeg: config.headingDeg ?? 0,
    at,
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
  communication: { state: 'connected' },
  provenance: { source: 'simulator', externalId: config.id },
  timestamps: { createdAt: at, updatedAt: at },
})

let commandSequence = 0

const command = (
  kind: string,
  payload: unknown,
  targetObjectIds: ReadonlyArray<ObjectId> = [],
): CommandEnvelope => {
  commandSequence += 1
  return {
    id: `command:drone-test-${commandSequence}` as CommandEnvelope['id'],
    controlInstanceId,
    actorId,
    kind,
    targetObjectIds,
    payload,
    issuedAt: at,
  }
}

const droneData = (object: OperationalObject) => {
  const parsed = dronePackDataSchema.safeParse(object.packData)
  if (!parsed.success) throw new Error(`invalid drone data for ${object.id}`)
  return parsed.data
}

const okResult = (response: PackQueryResponse): unknown => {
  if (!response.ok) throw new Error(response.reason)
  return response.result
}

describe('drone pack native runtime', () => {
  test('expands scenario drones into native vehicle state', async () => {
    const object = await droneScenarioSupport.expandObject({
      pack: 'drone',
      type: 'drone',
      id: 'drone:scenario-native',
      label: 'Scenario Native',
      position: [10.75, 59.91],
      modelId: 'native-survey-quad',
      altitudeM: 55,
      headingDeg: 35,
    }, {
      at,
      objects: [],
      objectById: () => undefined,
      routing: createDirectRoutingAdapter(),
      runtimeConfigs: { drone: { maxDrones: 10 } },
    })

    const data = droneData(object)
    expect(object.packId).toBe(dronePackId as PackId)
    expect(data.vehicle.modelId).toBe('native-survey-quad')
    expect(data.link.state).toBe('connected')
    expect(data.health.state).toBe('nominal')
    expect(data.vehicle.flightEnvelope.maxHorizontalSpeedMps).toBeGreaterThan(0)
  })

  test('native runtime parser merges model catalog overrides', () => {
    const model = effectModel()
    const parsed = parseDroneNativeRuntimeConfig({
      maxDrones: 4,
      stepIntervalMs: 10,
      projectionIntervalMs: 20,
      models: [model],
    })
    expect(parsed.maxDrones).toBe(4)
    expect(parsed.stepIntervalMs).toBe(10)
    expect(parsed.models.some(candidate => candidate.id === model.id)).toBe(true)
  })

  test('native manual flight uses the same body frame as the Babylon drone mesh', () => {
    expect(babylonYawRadForHeadingDeg(0)).toBeCloseTo(Math.PI)
    expect(babylonYawRadForHeadingDeg(90)).toBeCloseTo(Math.PI / 2)

    const northForward = horizontalVelocityFromBabylonBodyFrame({ headingDeg: 0, forwardMps: 12, rightMps: 0 })
    expect(northForward.eastMps).toBeCloseTo(0)
    expect(northForward.northMps).toBeCloseTo(12)

    const eastForward = horizontalVelocityFromBabylonBodyFrame({ headingDeg: 90, forwardMps: 12, rightMps: 0 })
    expect(eastForward.eastMps).toBeCloseTo(12)
    expect(eastForward.northMps).toBeCloseTo(0)

    const eastRight = horizontalVelocityFromBabylonBodyFrame({ headingDeg: 90, forwardMps: 0, rightMps: 12 })
    expect(eastRight.eastMps).toBeCloseTo(0)
    expect(eastRight.northMps).toBeCloseTo(-12)

    const body = bodyVelocityInBabylonFrame({ headingDeg: 90, eastMps: 12, northMps: 0 })
    expect(body.forwardMps).toBeCloseTo(12)
    expect(body.rightMps).toBeCloseTo(0)
  })

  test('native runtime accepts manual flight without explicit arm or takeoff', async () => {
    const initial = drone({ id: 'drone:native-manual-simple', altitudeM: 0, headingDeg: 90 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      controlInstanceId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-manual-simple',
        runtimeIds: [droneNativeRuntimeId],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigs: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 20 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 20 },
      },
    })
    const seen = new Map<string, OperationalObject>()
    const unsubscribe = connection.subscribe(emission => {
      for (const event of emission.events) {
        if (event.type === 'object.upserted') seen.set(event.object.id, event.object)
      }
    })

    try {
      expect(droneManualControlReadiness(droneData(initial)).ready).toBe(true)
      expect((await connection.sendCommand(command(manualControlCommandKind, {
        droneId: initial.id,
        axes: { forward: 1, right: 0, vertical: 1, yaw: 0 },
        inputSource: { kind: 'keyboard', label: 'Keyboard' },
        commandTtlMs: 500,
      }, [initial.id]))).ok).toBe(true)
      await waitForCondition('manual flight moves and climbs from rest', () => {
        const current = seen.get(initial.id)
        if (!current) return false
        const data = droneData(current)
        return data.pose.altitudeM > 0.2
          && data.pose.point.coordinates[0] > initial.spatial.position!.point.coordinates[0]
          && data.control.inputSource?.kind === 'keyboard'
      }, { timeoutMs: 900, intervalMs: 20 })
      const data = droneData(seen.get(initial.id)!)
      expect(data.attitude.pitchDeg).toBeLessThan(-0.1)
      expect(Math.abs(data.attitude.rollDeg)).toBeLessThan(4)
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native manual yaw follows the Babylon-positive control sign', async () => {
    const initial = drone({ id: 'drone:native-manual-yaw', altitudeM: 12, headingDeg: 0 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      controlInstanceId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-manual-yaw',
        runtimeIds: [droneNativeRuntimeId],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigs: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 20 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 20 },
      },
    })
    const seen = new Map<string, OperationalObject>()
    const unsubscribe = connection.subscribe(emission => {
      for (const event of emission.events) {
        if (event.type === 'object.upserted') seen.set(event.object.id, event.object)
      }
    })

    try {
      expect((await connection.sendCommand(command(manualControlCommandKind, {
        droneId: initial.id,
        axes: { forward: 0, right: 0, vertical: 0, yaw: 1 },
        inputSource: { kind: 'keyboard', label: 'Keyboard E' },
        commandTtlMs: 500,
      }, [initial.id]))).ok).toBe(true)
      await waitForCondition('positive manual yaw decreases geospatial heading', () => {
        const current = seen.get(initial.id)
        if (!current) return false
        const data = droneData(current)
        return data.pose.headingDeg > 340 && (data.attitude.yawRateDegPerSec ?? 0) < -1
      }, { timeoutMs: 800, intervalMs: 20 })
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native runtime executes arm, takeoff, goto, and manual control without external processes', async () => {
    const initial = drone({ id: 'drone:native-loop', altitudeM: 0, headingDeg: 0 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      controlInstanceId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-test',
        runtimeIds: [droneNativeRuntimeId],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigs: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 20 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 20 },
      },
    })
    const seen = new Map<string, OperationalObject>()
    const unsubscribe = connection.subscribe(emission => {
      for (const event of emission.events) {
        if (event.type === 'object.upserted') seen.set(event.object.id, event.object)
      }
    })

    try {
      expect((await connection.sendCommand(command(armDroneCommandKind, { droneId: initial.id, armed: true }, [initial.id]))).ok).toBe(true)
      expect((await connection.sendCommand(command(takeoffDroneCommandKind, { droneId: initial.id, altitudeM: 20 }, [initial.id]))).ok).toBe(true)
      await waitForCondition('native takeoff climbs', () => (droneData(seen.get(initial.id) ?? initial).pose.altitudeM > 1), { timeoutMs: 800, intervalMs: 20 })

      expect((await connection.sendCommand(command(navigateDroneCommandKind, {
        droneId: initial.id,
        target: {
          point: point(10.751, 59.91),
          altitudeM: 20,
          speedMps: 20,
        },
      }, [initial.id]))).ok).toBe(true)
      await waitForCondition('native goto moves east', () => {
        const current = seen.get(initial.id)
        return current !== undefined && droneData(current).pose.point.coordinates[0] > initial.spatial.position!.point.coordinates[0]
      }, { timeoutMs: 900, intervalMs: 20 })

      const current = seen.get(initial.id)
      expect(current).toBeDefined()
      const currentData = droneData(current!)
      expect(droneManualControlReadiness(currentData).ready).toBe(true)
      expect((await connection.sendCommand(command(manualControlCommandKind, {
        droneId: initial.id,
        axes: { forward: 1, right: 0, vertical: 0, yaw: 0 },
        inputSource: { kind: 'keyboard', label: 'Keyboard' },
        commandTtlMs: 300,
      }, [initial.id]))).ok).toBe(true)
      await waitForCondition('manual control records controller binding', () => {
        const object = seen.get(initial.id)
        return object !== undefined && droneData(object).control.inputSource?.kind === 'keyboard'
      }, { timeoutMs: 600, intervalMs: 20 })
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native create command does not require telemetry', async () => {
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({ controlInstanceId, initialObjects: [] })
    try {
      const result = await connection.sendCommand(command(createDroneCommandKind, {
        objectType: 'drone',
        label: 'Created Native',
        point: point(10.75, 59.91),
        modelId: 'native-survey-quad',
        altitudeM: 35,
      }))
      expect(result.ok).toBe(true)
      const snapshot = await connection.getSnapshot()
      expect(snapshot.objects.some(object => object.id === 'drone:created-native')).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('queries expose scene, bindings, map features, and model catalog', () => {
    const model = effectModel()
    const object = withDronePackData(
      drone({ id: 'drone:effect', model, altitudeM: 35 }),
      {
        ...droneData(drone({ id: 'drone:effect-source', model, altitudeM: 35 })),
        control: {
          inputSource: { kind: 'keyboard', label: 'Keyboard' },
          inputExpiresAt: at,
        },
      },
      at,
    )
    const objects = [object]

    expect(droneSceneObjects(objects)[0]?.modelId).toBe(model.id)
    expect(droneControllerBindings(objects)[0]?.inputKind).toBe('keyboard')
    expect(droneSensorContacts(objects)).toEqual([])

    const scene = okResult(answerDroneQuery({ request: { packId: dronePackId, kind: droneSceneQueryKind, payload: {} }, objects })) as { drones: ReadonlyArray<unknown> }
    const models = okResult(answerDroneQuery({ request: { packId: dronePackId, kind: droneVehicleModelsQueryKind, payload: {} }, objects, models: [model] })) as { models: ReadonlyArray<DroneVehicleModel> }
    const features = okResult(answerDroneQuery({ request: { packId: dronePackId, kind: droneMapFeaturesQueryKind, payload: {} }, objects })) as { features: ReadonlyArray<unknown> }
    const bindings = okResult(answerDroneQuery({ request: { packId: dronePackId, kind: droneControllerBindingsQueryKind, payload: {} }, objects })) as { bindings: ReadonlyArray<unknown> }

    expect(scene.drones).toHaveLength(1)
    expect(models.models[0]?.id).toBe(model.id)
    expect(features.features.length).toBeGreaterThan(0)
    expect(bindings.bindings).toHaveLength(1)
  })

  test('attack interaction handler applies drone effects through interaction signals', async () => {
    const attacker = drone({ id: 'drone:attacker', model: effectModel() })
    const target = genericTarget({ id: 'amb:target' })
    const handler = createDroneAttackInteractionHandler()
    const effects = await handler.handle({
      signal: droneAttackSignal({
        controlInstanceId,
        at,
        attackerId: attacker.id,
        targetId: target.id,
        payloadId: 'training-effect',
      }),
      snapshot: {
        objects: [attacker, target],
        seq: 1,
      },
      provenance: { source: 'operator' },
    })
    expect(effects.some(effect => effect.type === 'object.upsert')).toBe(true)
    expect(effects.some(effect => effect.type === 'notification.emit')).toBe(true)
  })

  test('drone pack presentation and creation commands expose native vehicle concepts', () => {
    const object = drone({ id: 'drone:presentation', modelId: 'native-gimbal-quad' })
    const presentation = dronePack.presentObject(object, { objects: [object] })
    const fieldsByKey = new Map(presentation.fields.map(field => [field.key, field.value]))

    expect(fieldsByKey.get('model')).toBe('Gimbal Quad')
    expect(fieldsByKey.get('link')).toBe('connected')
    expect(presentation.summary).toContain('Gimbal Quad')

    const commandRequest = dronePack.buildCreateObjectCommand('drone', 'New native drone', {
      kind: 'point',
      point: point(10.7, 59.9),
    }, {
      modelId: 'native-survey-quad',
      altitudeM: 45,
    })
    expect(commandRequest.kind).toBe(createDroneCommandKind)
    expect(commandRequest.payload).toMatchObject({
      objectType: 'drone',
      label: 'New native drone',
      modelId: 'native-survey-quad',
      altitudeM: 45,
    })
  })

  test('built-in drone scenario resolves through native runtime', () => {
    const catalog = createTestScenarioCatalog()
    const scenario = catalog.runtimeFor('oslo-drone-operations')
    expect(scenario?.runtimes.some(runtime => runtime.runtimeId === droneNativeRuntimeId)).toBe(true)
    expect(scenario?.initialObjects.some(object => object.packId === dronePackId)).toBe(true)
  })

  test('drone terrain helpers keep lon lat origin stable for scene renderer', async () => {
    const status = await loadDroneWorldTerrainStatus()
    expect(status.status).toBe('unavailable')
    const local = localPointFromLonLat(10.751, 59.91, { lon: 10.75, lat: 59.91 })
    expect(local.x).toBeGreaterThan(0)
    expect(Math.abs(local.z)).toBeLessThan(0.000001)
  })

  test('hold command is part of the native runtime command surface', () => {
    expect(dronePack.buildCancelTargetCommand(drone({ id: 'drone:cancel' }), { objects: [] }).kind).toBe(holdDroneCommandKind)
  })
})
