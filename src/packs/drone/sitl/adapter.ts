import type { CommandEnvelope, CommandResult, ControlInstanceEvent, IsoTimestamp, OperationalObject, SimulationClockState } from '../../../core/model/index.ts'
import { nowIso, objectIdSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeEmission, PackRuntimeEvent, PackRuntimeEventHandler, PackRuntimeSnapshot } from '../../../simulation/protocol.ts'
import {
  armDroneCommandKind,
  armDronePayloadSchema,
  attackCommandKind,
  attackPayloadSchema,
  clearDroneGeofenceCommandKind,
  clearDroneMissionCommandKind,
  configureDroneVehicleModelCommandKind,
  configureDroneVehicleModelPayloadSchema,
  createDroneCommandKind,
  createDronePayloadSchema,
  droneCommandKinds,
  holdDroneCommandKind,
  landDroneCommandKind,
  manualControlCommandKind,
  manualControlPayloadSchema,
  navigateDroneCommandKind,
  navigateDronePayloadSchema,
  pauseDroneMissionCommandKind,
  returnToLaunchDroneCommandKind,
  setDroneGimbalCommandKind,
  setDroneGimbalPayloadSchema,
  setDroneParameterCommandKind,
  setDroneParameterPayloadSchema,
  singleDronePayloadSchema,
  startDroneMissionCommandKind,
  swarmCommandKind,
  swarmCommandPayloadSchema,
  takeoffDroneCommandKind,
  takeoffDronePayloadSchema,
  uploadDroneGeofenceCommandKind,
  uploadDroneGeofencePayloadSchema,
  uploadDroneMissionCommandKind,
  uploadDroneMissionPayloadSchema,
} from '../commands.ts'
import { droneAttackSignal } from '../interactions.ts'
import {
  dronePackDataSchema,
  dronePackId,
  requireDroneVehicleModel,
  type DroneAutopilot,
  type DronePackData,
  type DroneVehicleModel,
} from '../model.ts'
import { answerDroneQuery, droneQueryKinds } from '../query.ts'
import { droneSitlAdapterId, droneSitlRuntimeId } from './constants.ts'
import { parseDroneSitlRuntimeConfig, type DroneSitlRuntimeConfig } from './config.ts'
import { createMavlinkClient, mavCmd, missionItemForPoint, type MavlinkClient, type MavlinkVehicleState } from './mavlink.ts'
import { createScenarioDroneObject, parseDroneObject, withDronePackData } from './object-state.ts'

const commandAccepted = (command: CommandEnvelope, acceptedAt: IsoTimestamp): CommandResult => ({
  ok: true,
  commandId: command.id,
  acceptedAt,
})

const commandRejected = (command: CommandEnvelope, rejectedAt: IsoTimestamp, reason: string): CommandResult => ({
  ok: false,
  commandId: command.id,
  rejectedAt,
  reason,
})

const systemStatusHealth = (vehicle: MavlinkVehicleState): DronePackData['health']['state'] => {
  if (vehicle.systemStatus === 6 || vehicle.systemStatus === 8) return 'failed'
  if (vehicle.systemStatus === 5) return 'critical'
  if (vehicle.systemStatus === 3 || vehicle.systemStatus === 4) return 'nominal'
  return 'unknown'
}

const autopilotFor = (
  configured: DroneAutopilot,
  vehicle: MavlinkVehicleState,
): DroneAutopilot =>
  vehicle.autopilot ?? configured

const armingStateFor = (
  current: DronePackData['arming'],
  vehicle: MavlinkVehicleState,
  at: IsoTimestamp,
): DronePackData['arming'] => {
  if (vehicle.baseMode === undefined) {
    return {
      ...current,
      state: 'unknown',
    }
  }
  return {
    state: vehicle.armed ? 'armed' : 'disarmed',
    armed: vehicle.armed,
    updatedAt: at,
  }
}

const projectData = (
  current: DronePackData,
  vehicle: MavlinkVehicleState,
  runtimeConfig: DroneSitlRuntimeConfig,
  endpointText: string,
  at: IsoTimestamp,
): DronePackData =>
  dronePackDataSchema.parse({
    ...current,
    autopilot: autopilotFor(runtimeConfig.autopilot, vehicle),
    link: {
      ...current.link,
      state: 'connected',
      endpoint: endpointText,
      lastHeartbeatAt: vehicle.lastHeartbeatAt,
      lastMessageAt: vehicle.lastMessageAt,
    },
    arming: armingStateFor(current.arming, vehicle, at),
    navigation: {
      kind: vehicle.navigation.kind,
      mode: vehicle.navigation.mode,
      customMode: vehicle.customMode,
      updatedAt: at,
    },
    pose: vehicle.pose === undefined
      ? current.pose
      : {
          point: vehicle.pose.point,
          altitudeM: vehicle.pose.altitudeM,
          relativeAltitudeM: vehicle.pose.relativeAltitudeM,
          headingDeg: vehicle.pose.headingDeg,
          accuracyM: current.pose.accuracyM,
          observedAt: vehicle.pose.observedAt,
        },
    velocity: vehicle.velocity === undefined
      ? current.velocity
      : {
          eastMps: vehicle.velocity.eastMps,
          northMps: vehicle.velocity.northMps,
          downMps: vehicle.velocity.downMps,
          groundSpeedMps: Math.hypot(vehicle.velocity.eastMps, vehicle.velocity.northMps),
          verticalSpeedMps: -vehicle.velocity.downMps,
        },
    attitude: vehicle.attitude === undefined ? current.attitude : vehicle.attitude,
    battery: vehicle.battery ?? current.battery,
    health: {
      ...current.health,
      state: current.health.state === 'destroyed' ? 'destroyed' : systemStatusHealth(vehicle),
      lastStatusText: vehicle.lastStatusText ?? current.health.lastStatusText,
    },
    mission: {
      ...current.mission,
      ...(vehicle.mission === undefined
        ? {}
        : {
            state: 'running',
            currentSeq: vehicle.mission.currentSeq,
            total: vehicle.mission.total,
            updatedAt: vehicle.mission.updatedAt,
          }),
    },
  })

const vehicleBySystemId = (
  objects: ReadonlyMap<string, OperationalObject>,
  systemId: number,
): OperationalObject | undefined =>
  [...objects.values()].find(object => parseDroneObject(object)?.vehicle.systemId === systemId)

const objectData = (objects: ReadonlyMap<string, OperationalObject>, droneId: string): {
  readonly object: OperationalObject
  readonly data: DronePackData
} => {
  const object = objects.get(droneId)
  if (!object) throw new Error(`unknown drone object: ${droneId}`)
  const data = parseDroneObject(object)
  if (!data) throw new Error(`object is not a valid SITL drone: ${droneId}`)
  return { object, data }
}

const connectedVehicle = (client: MavlinkClient, data: DronePackData): MavlinkVehicleState => {
  const vehicle = client.vehicle(data.vehicle.systemId)
  if (!vehicle) throw new Error(`MAVLink system ${data.vehicle.systemId} is not connected`)
  return vehicle
}

const endpointTextForSystemId = (
  runtimeConfig: DroneSitlRuntimeConfig,
  systemId: number,
): string => {
  const index = systemId - runtimeConfig.systemIdBase
  return runtimeConfig.endpointTexts[index] ?? runtimeConfig.endpointText
}

const paramTypeCode = (valueType: string): number => {
  if (valueType === 'uint8') return 1
  if (valueType === 'int8') return 2
  if (valueType === 'uint16') return 3
  if (valueType === 'int16') return 4
  if (valueType === 'uint32') return 5
  if (valueType === 'int32') return 6
  return 9
}

const missionFrameCode = (frame: 'global' | 'global_relative_alt' | 'mission'): number => {
  if (frame === 'global') return 0
  if (frame === 'mission') return 2
  return 3
}

const commandWithCurrentPoint = (
  client: MavlinkClient,
  data: DronePackData,
  command: number,
  params: readonly number[] = [],
): Promise<unknown> =>
  client.commandLong({
    targetSystem: data.vehicle.systemId,
    targetComponent: data.vehicle.componentId,
    command,
    params: [
      params[0] ?? 0,
      params[1] ?? 0,
      params[2] ?? 0,
      params[3] ?? data.pose.headingDeg,
      params[4] ?? data.pose.point.coordinates[0],
      params[5] ?? data.pose.point.coordinates[1],
      params[6] ?? data.pose.altitudeM,
    ],
  })

const slugObjectId = (prefix: string, label: string): OperationalObject['id'] => {
  const slug = label.toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '') || 'vehicle'
  return objectIdSchema.parse(`${prefix}:${slug}`)
}

export const createDroneSitlPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: droneSitlRuntimeId,
  packId: dronePackId,
  acceptedCommandKinds: droneCommandKinds,
  queryKinds: droneQueryKinds,
  connect: async (config): Promise<PackRuntimeConnection> => {
    const runtimeConfig = parseDroneSitlRuntimeConfig(config.scenario?.runtimeConfig ?? {})
    const clients = runtimeConfig.endpoints.map(endpoint => createMavlinkClient({
      endpoint,
      sourceSystemId: runtimeConfig.sourceSystemId,
      sourceComponentId: runtimeConfig.sourceComponentId,
      heartbeatTimeoutMs: runtimeConfig.heartbeatTimeoutMs,
      commandTimeoutMs: runtimeConfig.commandTimeoutMs,
    }))
    const objects = new Map<string, OperationalObject>()
    for (const object of config.initialObjects ?? config.scenario?.initialObjects ?? []) {
      const data = parseDroneObject(object)
      if (data) objects.set(object.id, object)
    }
    const handlers = new Set<PackRuntimeEventHandler>()
    let closed = false
    let lastEmissionAt = 0

    const emit = (events: ReadonlyArray<PackRuntimeEvent>): void => {
      if (events.length === 0 || closed) return
      const emission: PackRuntimeEmission = {
        type: 'event.emission',
        runtimeId: droneSitlRuntimeId,
        emittedAt: nowIso(),
        events,
      }
      for (const handler of handlers) handler(emission)
    }

    const emitObjectUpsert = (
      object: OperationalObject,
      at: IsoTimestamp,
      persistence: 'durable' | 'projected',
      command?: CommandEnvelope,
    ): void => {
      const data = parseDroneObject(object)
      emit([{
        type: 'object.upserted',
        object,
        at,
        persistence,
        provenance: {
          source: command ? 'operator' : 'simulator',
          adapterId: droneSitlAdapterId,
          ...(data === null ? {} : { externalId: `${data.vehicle.systemId}:${data.vehicle.componentId}` }),
          ...(command === undefined ? {} : { causedByCommandId: command.id }),
        },
      }])
    }

    const allVehicles = (): ReadonlyArray<MavlinkVehicleState> =>
      clients.flatMap(client => client.vehicles())

    const vehicleForSystemId = (systemId: number): MavlinkVehicleState | undefined =>
      allVehicles().find(vehicle => vehicle.systemId === systemId)

    const clientForSystemId = (systemId: number): MavlinkClient => {
      const observedClient = clients.find(client => client.vehicle(systemId) !== undefined)
      if (observedClient) return observedClient
      const index = systemId - runtimeConfig.systemIdBase
      return clients[index] ?? clients[0]!
    }

    const connectedVehicleForData = (data: DronePackData): {
      readonly client: MavlinkClient
      readonly vehicle: MavlinkVehicleState
    } => {
      const client = clientForSystemId(data.vehicle.systemId)
      return { client, vehicle: connectedVehicle(client, data) }
    }

    const projectVehicles = (): void => {
      const nowMs = Date.now()
      if (nowMs - lastEmissionAt < 100) return
      lastEmissionAt = nowMs
      const at = nowIso()
      const events: PackRuntimeEvent[] = []
      for (const vehicle of allVehicles()) {
        const object = vehicleBySystemId(objects, vehicle.systemId)
        if (!object) continue
        const current = parseDroneObject(object)
        if (!current) continue
        const next = withDronePackData(object, projectData(current, vehicle, runtimeConfig, endpointTextForSystemId(runtimeConfig, vehicle.systemId), at), at)
        objects.set(next.id, next)
        events.push({
          type: 'object.upserted',
          object: next,
          at,
          persistence: 'projected',
          provenance: {
            source: 'simulator',
            adapterId: droneSitlAdapterId,
            externalId: `${vehicle.systemId}:${vehicle.componentId}`,
          },
        })
      }
      emit(events)
    }

    await Promise.all(clients.map(client => client.open()))
    const unsubscribeClients = clients.map(client => client.subscribe(projectVehicles))
    projectVehicles()

    const handleCommand = async (command: CommandEnvelope): Promise<void> => {
      if (command.kind === createDroneCommandKind) {
        const payload = createDronePayloadSchema.parse(command.payload)
        const model = requireDroneVehicleModel(payload.modelId, runtimeConfig.models)
        const systemId = payload.systemId ?? (() => {
          const connected = allVehicles().find(candidate => !vehicleBySystemId(objects, candidate.systemId))
          if (!connected) throw new Error('create_vehicle requires an unclaimed connected MAVLink vehicle or explicit systemId')
          return connected.systemId
        })()
        const vehicle = vehicleForSystemId(systemId)
        if (!vehicle) throw new Error(`cannot create drone for MAVLink system ${systemId}: no MAVLink telemetry`)
        const createdAt = nowIso()
        const object = createScenarioDroneObject({
          id: slugObjectId('drone', payload.label),
          label: payload.label,
          autopilot: autopilotFor(runtimeConfig.autopilot, vehicle),
          model,
          point: payload.point,
          altitudeM: payload.altitudeM,
          headingDeg: payload.headingDeg,
          at: createdAt,
          systemId,
          endpoint: endpointTextForSystemId(runtimeConfig, systemId),
        })
        objects.set(object.id, object)
        emitObjectUpsert(object, createdAt, 'durable', command)
        return
      }

      if (command.kind === armDroneCommandKind) {
        const payload = armDronePayloadSchema.parse(command.payload)
        const { data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.commandLong({
          targetSystem: data.vehicle.systemId,
          targetComponent: data.vehicle.componentId,
          command: mavCmd.componentArmDisarm,
          params: [payload.armed ? 1 : 0],
        })
        return
      }

      if (command.kind === manualControlCommandKind) {
        const payload = manualControlPayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.manualControl({
          targetSystem: data.vehicle.systemId,
          x: Math.round(payload.axes.forward * 1_000),
          y: Math.round(payload.axes.right * 1_000),
          z: Math.round((payload.axes.vertical + 1) * 500),
          r: Math.round(payload.axes.yaw * 1_000),
        })
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          control: {
            ...data.control,
            manualAxes: payload.axes,
            inputSource: payload.inputSource,
            lastCommandAt: at,
            inputExpiresAt: new Date(Date.now() + payload.commandTtlMs).toISOString() as IsoTimestamp,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'projected', command)
        return
      }

      if (command.kind === navigateDroneCommandKind) {
        const payload = navigateDronePayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.commandInt({
          targetSystem: data.vehicle.systemId,
          targetComponent: data.vehicle.componentId,
          command: mavCmd.doReposition,
          frame: 6,
          x: Math.round(payload.target.point.coordinates[1] * 1e7),
          y: Math.round(payload.target.point.coordinates[0] * 1e7),
          z: payload.target.altitudeM,
          params: [payload.target.speedMps ?? -1, 0, 0, 0],
        })
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          control: {
            ...data.control,
            guidedTarget: payload.target,
            lastCommandAt: at,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'durable', command)
        return
      }

      if (command.kind === takeoffDroneCommandKind) {
        const payload = takeoffDronePayloadSchema.parse(command.payload)
        const { data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await commandWithCurrentPoint(client, data, mavCmd.navTakeoff, [0, 0, 0, data.pose.headingDeg, data.pose.point.coordinates[0], data.pose.point.coordinates[1], payload.altitudeM])
        return
      }

      if (command.kind === landDroneCommandKind || command.kind === returnToLaunchDroneCommandKind || command.kind === holdDroneCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        const mavlinkCommand = command.kind === landDroneCommandKind
          ? mavCmd.navLand
          : command.kind === returnToLaunchDroneCommandKind
            ? mavCmd.navReturnToLaunch
            : mavCmd.navLoiterUnlim
        await commandWithCurrentPoint(client, data, mavlinkCommand)
        return
      }

      if (command.kind === uploadDroneMissionCommandKind) {
        const payload = uploadDroneMissionPayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.uploadMission({
          targetSystem: data.vehicle.systemId,
          targetComponent: data.vehicle.componentId,
          missionType: 0,
          items: payload.items.map(item => missionItemForPoint({
            seq: item.seq,
            command: item.command,
            point: item.point ?? data.pose.point,
            altitudeM: item.altitudeM ?? data.pose.altitudeM,
            frame: missionFrameCode(item.frame),
            params: [item.param1, item.param2, item.param3, item.param4],
            autocontinue: item.autocontinue,
          })),
        })
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          mission: {
            state: 'ready',
            total: payload.items.length,
            planId: payload.planId,
            updatedAt: at,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'durable', command)
        return
      }

      if (command.kind === startDroneMissionCommandKind || command.kind === pauseDroneMissionCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.commandLong({
          targetSystem: data.vehicle.systemId,
          targetComponent: data.vehicle.componentId,
          command: command.kind === startDroneMissionCommandKind ? mavCmd.missionStart : mavCmd.doPauseContinue,
          params: command.kind === startDroneMissionCommandKind ? [0, 0] : [0],
        })
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          mission: {
            ...data.mission,
            state: command.kind === startDroneMissionCommandKind ? 'running' : 'paused',
            updatedAt: at,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'durable', command)
        return
      }

      if (command.kind === clearDroneMissionCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.clearMission({ targetSystem: data.vehicle.systemId, targetComponent: data.vehicle.componentId, missionType: 0 })
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          mission: {
            state: 'idle',
            updatedAt: at,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'durable', command)
        return
      }

      if (command.kind === uploadDroneGeofenceCommandKind) {
        const payload = uploadDroneGeofencePayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        const vertices = payload.polygons.flatMap(polygon => polygon.coordinates[0] ?? [])
        await client.uploadMission({
          targetSystem: data.vehicle.systemId,
          targetComponent: data.vehicle.componentId,
          missionType: 1,
          items: vertices.map((coordinate, index) => missionItemForPoint({
            seq: index,
            command: mavCmd.navFencePolygonVertexInclusion,
            point: { type: 'Point', coordinates: coordinate },
            altitudeM: data.pose.altitudeM,
            frame: 0,
            params: [vertices.length],
            missionType: 1,
          })),
        })
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          geofence: {
            loaded: true,
            breachStatus: 'unknown',
            updatedAt: at,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'durable', command)
        return
      }

      if (command.kind === clearDroneGeofenceCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.clearMission({ targetSystem: data.vehicle.systemId, targetComponent: data.vehicle.componentId, missionType: 1 })
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          geofence: {
            loaded: false,
            breachStatus: 'unknown',
            updatedAt: at,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'durable', command)
        return
      }

      if (command.kind === setDroneParameterCommandKind) {
        const payload = setDroneParameterPayloadSchema.parse(command.payload)
        const { data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.setParameter({
          targetSystem: data.vehicle.systemId,
          targetComponent: data.vehicle.componentId,
          name: payload.name,
          value: payload.value,
          paramType: paramTypeCode(payload.valueType),
        })
        return
      }

      if (command.kind === setDroneGimbalCommandKind) {
        const payload = setDroneGimbalPayloadSchema.parse(command.payload)
        const { data } = objectData(objects, payload.droneId)
        const { client } = connectedVehicleForData(data)
        await client.commandLong({
          targetSystem: data.vehicle.systemId,
          targetComponent: data.vehicle.componentId,
          command: mavCmd.doGimbalManagerPitchYaw,
          params: [payload.pitchDeg, payload.yawDeg, 0, 0, 16],
        })
        return
      }

      if (command.kind === configureDroneVehicleModelCommandKind) {
        const payload = configureDroneVehicleModelPayloadSchema.parse(command.payload)
        const { object, data } = objectData(objects, payload.droneId)
        const model: DroneVehicleModel = payload.model
        const at = nowIso()
        const next = withDronePackData(object, {
          ...data,
          vehicle: {
            ...data.vehicle,
            modelId: model.id,
            modelLabel: model.label,
            autopilotModel: model.autopilotModel,
            gazeboModel: model.gazeboModel,
            airframe: model.airframe,
            capabilities: model.capabilities,
            sensors: model.sensors,
            payloads: model.payloads,
            visual: model.visual,
          },
        }, at)
        objects.set(next.id, next)
        emitObjectUpsert(next, at, 'durable', command)
        return
      }

      if (command.kind === swarmCommandKind) {
        const payload = swarmCommandPayloadSchema.parse(command.payload)
        const targetObjects = [...objects.values()].filter(object => {
          const data = parseDroneObject(object)
          if (!data) return false
          return payload.droneIds.includes(object.id) || (payload.swarmId !== undefined && data.swarm?.swarmId === payload.swarmId)
        })
        for (const object of targetObjects) {
          const data = parseDroneObject(object)
          if (!data) continue
          const { client } = connectedVehicleForData(data)
          if (payload.command.kind === 'hold') await commandWithCurrentPoint(client, data, mavCmd.navLoiterUnlim)
          if (payload.command.kind === 'land') await commandWithCurrentPoint(client, data, mavCmd.navLand)
          if (payload.command.kind === 'navigate') {
            await client.commandInt({
              targetSystem: data.vehicle.systemId,
              targetComponent: data.vehicle.componentId,
              command: mavCmd.doReposition,
              frame: 6,
              x: Math.round(payload.command.target.point.coordinates[1] * 1e7),
              y: Math.round(payload.command.target.point.coordinates[0] * 1e7),
              z: payload.command.target.altitudeM,
              params: [payload.command.target.speedMps ?? -1, 0, 0, 0],
            })
          }
        }
        return
      }

      if (command.kind === attackCommandKind) {
        const payload = attackPayloadSchema.parse(command.payload)
        const at = nowIso()
        emit([{
          type: 'interaction.signal',
          signal: droneAttackSignal({
            controlInstanceId: command.controlInstanceId,
            at,
            attackerId: payload.attackerId,
            targetId: payload.targetId,
            ...(payload.payloadId === undefined ? {} : { payloadId: payload.payloadId }),
            causationId: command.id,
          }),
          at,
          persistence: 'durable',
          provenance: { source: 'operator', adapterId: droneSitlAdapterId, causedByCommandId: command.id },
        }])
        return
      }

      throw new Error(`unsupported drone command kind: ${command.kind}`)
    }

    return {
      getSnapshot: async (): Promise<PackRuntimeSnapshot> => ({
        controlInstanceId: config.controlInstanceId,
        objects: [...objects.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const at = nowIso()
        try {
          await handleCommand(command)
          return commandAccepted(command, at)
        } catch (err) {
          return commandRejected(command, nowIso(), err instanceof Error ? err.message : String(err))
        }
      },
      query: async (request: PackQueryRequest): Promise<PackQueryResponse> =>
        answerDroneQuery({ request, objects: [...objects.values()], models: runtimeConfig.models }),
      observeCommittedEvents: async (events: ReadonlyArray<ControlInstanceEvent>): Promise<void> => {
        for (const event of events) {
          if (event.controlInstanceId !== config.controlInstanceId) continue
          if (event.type === 'object.upserted') {
            const data = parseDroneObject(event.object)
            if (data) objects.set(event.object.id, event.object)
            else objects.delete(event.object.id)
          }
          if (event.type === 'object.deleted') {
            objects.delete(event.objectId)
          }
        }
      },
      setClock: async (_clock: SimulationClockState): Promise<void> => {},
      close: async (): Promise<void> => {
        closed = true
        for (const unsubscribeClient of unsubscribeClients) unsubscribeClient()
        handlers.clear()
        await Promise.all(clients.map(client => client.close()))
      },
    }
  },
})
