import type {
  CommandEnvelope,
  CommandResult,
  ControlInstanceEvent,
  ControlInstanceId,
  GeoJsonPoint,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
} from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type { PackRuntimeEvent, PackRuntimeSnapshot } from '../../../simulation/protocol.ts'
import {
  attackCommandKind,
  attackPayloadSchema,
  configureDroneProfileCommandKind,
  configureDroneProfilePayloadSchema,
  createDroneCommandKind,
  createDronePayloadSchema,
  manualControlCommandKind,
  manualControlPayloadSchema,
  navigateDroneCommandKind,
  navigateDronePayloadSchema,
  setDroneModeCommandKind,
  setDroneModePayloadSchema,
  swarmCommandKind,
  swarmCommandPayloadSchema,
} from '../commands.ts'
import { droneAttackSignal } from '../interactions.ts'
import {
  defaultDroneEnvironment,
  defaultDroneProfiles,
  droneHasCapability,
  droneGuidedTargetSchema,
  dronePackDataSchema,
  requireDroneProfile,
  type DroneEnvironment,
  type DroneGuidedTarget,
  type DroneManualAxes,
  type DronePackData,
  type DroneProfile,
  type DroneSwarmMembership,
} from '../model.ts'
import { droneSimAdapterId, droneSimPackId, droneSimRuntimeId } from './constants.ts'
import { bearingDeg, clamp, horizontalDistanceM, movePointByMeters, normalizeAngleDeg, offsetMeters } from './flight-math.ts'
import { createScenarioDroneObject, parseDroneObject, withDronePackData } from './object-state.ts'
import { integrateDronePhysics } from './physics.ts'

const emitMinIntervalMs = 180
const defaultTickMs = 100
const hoverArrivalRadiusM = 2.5
const guidedSlowRadiusM = 45

export interface DroneSimEngine {
  readonly snapshot: () => PackRuntimeSnapshot
  readonly tick: (elapsedMs?: number, at?: IsoTimestamp) => ReadonlyArray<PackRuntimeEvent>
  readonly handleCommand: (command: CommandEnvelope) => Promise<{
    readonly result: CommandResult
    readonly events: ReadonlyArray<PackRuntimeEvent>
  }>
  readonly observeCommittedEvents: (events: ReadonlyArray<ControlInstanceEvent>) => void
}

interface DroneEngineState {
  readonly controlInstanceId: ControlInstanceId
  readonly objects: Map<string, OperationalObject>
  readonly profiles: ReadonlyArray<DroneProfile>
  readonly environment: DroneEnvironment
  readonly homePoints: Map<string, { readonly point: GeoJsonPoint; readonly altitudeM: number }>
  nextObjectNumber: number
  clock: IsoTimestamp
  lastEmitAtMs: number
}

const parseRestoredDroneObject = (object: OperationalObject): OperationalObject => {
  const parsed = dronePackDataSchema.safeParse(object.packData)
  if (!parsed.success) throw new Error(`invalid restored drone object pack data for ${object.id}: ${parsed.error.message}`)
  return { ...object, packData: parsed.data }
}

const nextNumberAfter = (objects: Iterable<OperationalObject>): number => {
  let highest = 0
  for (const object of objects) {
    const match = object.id.match(/^drone:unit-(\d+)$/)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isInteger(value) && value > highest) highest = value
  }
  return highest + 1
}

const commandResultOk = (command: CommandEnvelope, at: IsoTimestamp): CommandResult => ({
  ok: true,
  commandId: command.id,
  acceptedAt: at,
})

const commandResultRejected = (command: CommandEnvelope, at: IsoTimestamp, reason: string): CommandResult => ({
  ok: false,
  commandId: command.id,
  rejectedAt: at,
  reason,
})

const requireDrone = (
  state: DroneEngineState,
  droneId: ObjectId,
): { readonly object: OperationalObject; readonly data: DronePackData } => {
  const object = state.objects.get(droneId)
  if (!object) throw new Error(`unknown drone: ${droneId}`)
  const data = parseDroneObject(object)
  if (!data) throw new Error(`object is not a drone: ${droneId}`)
  return { object, data }
}

const pointFor = (object: OperationalObject): GeoJsonPoint => {
  const point = object.spatial.position?.point
  if (!point) throw new Error(`drone ${object.id} has no position`)
  return point
}

const updateObject = (
  state: DroneEngineState,
  object: OperationalObject,
): void => {
  state.objects.set(object.id, object)
}

const packRuntimeObjectEvent = (object: OperationalObject, at: IsoTimestamp): PackRuntimeEvent => ({
  type: 'object.upserted',
  object,
  at,
  provenance: object.provenance,
  persistence: 'projected',
})

const finiteCommandTime = (date: Date): IsoTimestamp =>
  date.toISOString() as IsoTimestamp

const operationalCommandTime = (): IsoTimestamp => nowIso()

const dataWithControl = (
  data: DronePackData,
  control: DronePackData['control'],
): DronePackData => ({
  ...data,
  control,
})

const setControlMode = (
  state: DroneEngineState,
  command: CommandEnvelope,
  droneId: ObjectId,
  data: DronePackData,
  at: IsoTimestamp,
  mode: DronePackData['control']['mode'],
  extra: Partial<DronePackData['control']> = {},
): OperationalObject => {
  const { object } = requireDrone(state, droneId)
  const next = withDronePackData(object, dataWithControl(data, {
    mode,
    pilotActorId: command.actorId,
    lastCommandAt: at,
    ...extra,
  }), at, { causedByCommandId: command.id })
  updateObject(state, next)
  return next
}

const handleCreateDrone = (
  state: DroneEngineState,
  command: CommandEnvelope,
  at: IsoTimestamp,
): OperationalObject => {
  const payload = createDronePayloadSchema.parse(command.payload)
  const profile = requireDroneProfile(payload.profileId, state.profiles)
  const object = createScenarioDroneObject({
    id: `drone:unit-${state.nextObjectNumber++}` as ObjectId,
    label: payload.label,
    point: payload.point,
    profile,
    altitudeM: payload.altitudeM,
    headingDeg: payload.headingDeg,
    at,
    mode: 'hold',
    causedByCommandId: command.id,
  })
  updateObject(state, object)
  state.homePoints.set(object.id, { point: payload.point, altitudeM: payload.altitudeM })
  return object
}

const applyManualControl = (
  state: DroneEngineState,
  command: CommandEnvelope,
  at: IsoTimestamp,
): OperationalObject => {
  const payload = manualControlPayloadSchema.parse(command.payload)
  const { data } = requireDrone(state, payload.droneId)
  if (data.health.state === 'destroyed' || data.health.state === 'disabled') throw new Error(`drone ${payload.droneId} cannot accept manual control while ${data.health.state}`)
  if (!droneHasCapability(data.profile, 'manual_control')) throw new Error(`drone profile ${data.profile.id} lacks manual_control capability`)
  const inputExpiresAt = finiteCommandTime(new Date(Date.parse(at) + payload.commandTtlMs))
  return setControlMode(state, command, payload.droneId, data, at, 'manual', {
    manualAxes: payload.axes,
    inputSource: payload.inputSource,
    inputExpiresAt,
  })
}

const applyNavigate = (
  state: DroneEngineState,
  command: CommandEnvelope,
  at: IsoTimestamp,
): OperationalObject => {
  const payload = navigateDronePayloadSchema.parse(command.payload)
  const { data } = requireDrone(state, payload.droneId)
  if (data.health.state === 'destroyed' || data.health.state === 'disabled') throw new Error(`drone ${payload.droneId} cannot navigate while ${data.health.state}`)
  if (!droneHasCapability(data.profile, 'guided_navigation')) throw new Error(`drone profile ${data.profile.id} lacks guided_navigation capability`)
  return setControlMode(state, command, payload.droneId, data, at, 'guided', {
    guidedTarget: payload.target,
  })
}

const applyMode = (
  state: DroneEngineState,
  command: CommandEnvelope,
  at: IsoTimestamp,
): OperationalObject => {
  const payload = setDroneModePayloadSchema.parse(command.payload)
  const { object, data } = requireDrone(state, payload.droneId)
  const home = state.homePoints.get(payload.droneId)
  const guidedTarget = payload.mode === 'return_to_launch' && home
    ? droneGuidedTargetSchema.parse({ point: home.point, altitudeM: home.altitudeM })
    : data.control.guidedTarget
  const { manualAxes: _manualAxes, inputExpiresAt: _inputExpiresAt, inputSource: _inputSource, ...baseControl } = data.control
  const next = withDronePackData(object, dataWithControl(data, {
    ...baseControl,
    mode: payload.mode,
    pilotActorId: command.actorId,
    lastCommandAt: at,
    ...(guidedTarget === undefined ? {} : { guidedTarget }),
  }), at, { causedByCommandId: command.id })
  updateObject(state, next)
  return next
}

const applyProfile = (
  state: DroneEngineState,
  command: CommandEnvelope,
  at: IsoTimestamp,
): OperationalObject => {
  const payload = configureDroneProfilePayloadSchema.parse(command.payload)
  const { object, data } = requireDrone(state, payload.droneId)
  const nextRemainingWh = clamp(data.energy.remainingWh, 0, payload.profile.energy.capacityWh)
  const next = withDronePackData(object, {
    ...data,
    profile: payload.profile,
    energy: {
      remainingWh: nextRemainingWh,
      consumedWh: data.energy.consumedWh,
      voltageV: payload.profile.energy.nominalVoltageV * Math.max(0.65, nextRemainingWh / payload.profile.energy.capacityWh),
    },
  }, at, { causedByCommandId: command.id })
  updateObject(state, next)
  return next
}

const formationSlotFor = (
  index: number,
  count: number,
  spacingM: number,
  altitudeStepM: number,
): DroneSwarmMembership['slot'] => {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  const row = Math.floor(index / columns)
  const col = index % columns
  const center = (columns - 1) / 2
  return [
    (col - center) * spacingM,
    -row * spacingM,
    altitudeStepM * row,
  ]
}

const selectedSwarmDrones = (
  state: DroneEngineState,
  swarmId: string | undefined,
  droneIds: ReadonlyArray<ObjectId>,
): ReadonlyArray<{ readonly object: OperationalObject; readonly data: DronePackData }> =>
  [...state.objects.values()]
    .flatMap(object => {
      const data = parseDroneObject(object)
      if (!data) return []
      const selectedById = droneIds.length > 0 && droneIds.includes(object.id)
      const selectedBySwarm = swarmId !== undefined && data.swarm?.swarmId === swarmId
      return selectedById || selectedBySwarm ? [{ object, data }] : []
    })

const applySwarmCommand = (
  state: DroneEngineState,
  command: CommandEnvelope,
  at: IsoTimestamp,
): ReadonlyArray<OperationalObject> => {
  const payload = swarmCommandPayloadSchema.parse(command.payload)
  const selected = selectedSwarmDrones(state, payload.swarmId, payload.droneIds)
  if (selected.length === 0) throw new Error('swarm command selected no drones')
  const updated: OperationalObject[] = []
  const commandSwarmId = payload.swarmId ?? `swarm:${command.id}`
  for (const [index, entry] of selected.entries()) {
    if (!droneHasCapability(entry.data.profile, 'swarm_member')) throw new Error(`drone profile ${entry.data.profile.id} lacks swarm_member capability`)
    const point = pointFor(entry.object)
    let guidedTarget: DroneGuidedTarget | undefined
    let mode: DronePackData['control']['mode'] = 'swarm'
    let swarm: DroneSwarmMembership | undefined = entry.data.swarm ?? {
      swarmId: commandSwarmId,
      role: index === 0 ? 'leader' : 'member',
      slot: formationSlotFor(index, selected.length, 18, 0),
      separationRadiusM: 8,
    }
    if (payload.command.kind === 'hold') mode = 'hold'
    if (payload.command.kind === 'land') mode = 'land'
    if (payload.command.kind === 'navigate') {
      const slot = formationSlotFor(index, selected.length, payload.command.formation.spacingM, payload.command.formation.altitudeStepM)
      swarm = { ...swarm, swarmId: commandSwarmId, role: index === 0 ? 'leader' : 'member', slot }
      guidedTarget = droneGuidedTargetSchema.parse({
        ...payload.command.target,
        altitudeM: payload.command.target.altitudeM + slot[2],
      })
    }
    if (payload.command.kind === 'search_area') {
      const angle = selected.length === 1 ? 0 : (index / selected.length) * Math.PI * 2
      const ring = Math.min(payload.command.radiusM, Math.max(12, payload.command.formation.spacingM * Math.ceil((index + 1) / 6)))
      guidedTarget = droneGuidedTargetSchema.parse({
        point: movePointByMeters(payload.command.center, {
          eastM: Math.sin(angle) * ring,
          northM: Math.cos(angle) * ring,
        }),
        altitudeM: payload.command.altitudeM,
      })
      swarm = { ...swarm, swarmId: commandSwarmId, role: index === 0 ? 'leader' : 'member', slot: formationSlotFor(index, selected.length, payload.command.formation.spacingM, payload.command.formation.altitudeStepM) }
    }
    if (payload.command.kind === 'disperse') {
      const angle = selected.length === 1 ? 0 : (index / selected.length) * Math.PI * 2
      guidedTarget = droneGuidedTargetSchema.parse({
        point: movePointByMeters(point, {
          eastM: Math.sin(angle) * payload.command.radiusM,
          northM: Math.cos(angle) * payload.command.radiusM,
        }),
        altitudeM: entry.data.kinematics.altitudeM,
      })
    }
    const nextData: DronePackData = {
      ...entry.data,
      swarm,
      control: {
        ...entry.data.control,
        mode,
        pilotActorId: command.actorId,
        lastCommandAt: at,
        ...(guidedTarget === undefined ? {} : { guidedTarget }),
      },
    }
    const next = withDronePackData(entry.object, nextData, at, { causedByCommandId: command.id })
    updateObject(state, next)
    updated.push(next)
  }
  return updated
}

const desiredVelocityManual = (
  data: DronePackData,
  axes: DroneManualAxes,
): {
  readonly eastMps: number
  readonly northMps: number
  readonly verticalMps: number
} => {
  const yawRad = data.kinematics.yawDeg * Math.PI / 180
  const forwardEast = Math.sin(yawRad)
  const forwardNorth = Math.cos(yawRad)
  const rightEast = Math.cos(yawRad)
  const rightNorth = -Math.sin(yawRad)
  const speed = data.profile.dynamics.maxHorizontalSpeedMps
  return {
    eastMps: (axes.forward * forwardEast + axes.right * rightEast) * speed,
    northMps: (axes.forward * forwardNorth + axes.right * rightNorth) * speed,
    verticalMps: axes.vertical * data.profile.dynamics.maxVerticalSpeedMps,
  }
}

const desiredVelocityToTarget = (
  point: GeoJsonPoint,
  data: DronePackData,
  target: DroneGuidedTarget,
): {
  readonly eastMps: number
  readonly northMps: number
  readonly verticalMps: number
  readonly yawDeg: number
} => {
  const offset = offsetMeters(point, target.point)
  const distance = Math.hypot(offset.eastM, offset.northM)
  const maxSpeed = Math.min(target.speedMps ?? data.profile.dynamics.maxHorizontalSpeedMps, data.profile.dynamics.maxHorizontalSpeedMps)
  const speed = distance <= hoverArrivalRadiusM ? 0 : Math.min(maxSpeed, maxSpeed * distance / guidedSlowRadiusM)
  const scale = distance > 0 ? speed / distance : 0
  const altitudeError = target.altitudeM - data.kinematics.altitudeM
  return {
    eastMps: offset.eastM * scale,
    northMps: offset.northM * scale,
    verticalMps: clamp(altitudeError * data.profile.dynamics.controller.altitudeP, -data.profile.dynamics.maxVerticalSpeedMps, data.profile.dynamics.maxVerticalSpeedMps),
    yawDeg: distance > 1 ? bearingDeg(point, target.point) : data.kinematics.yawDeg,
  }
}

const integrateDrone = (
  object: OperationalObject,
  data: DronePackData,
  elapsedSeconds: number,
  at: IsoTimestamp,
  environment: DroneEnvironment,
): { readonly object: OperationalObject; readonly changed: boolean } => {
  if (data.health.state === 'destroyed' || data.health.state === 'disabled') return { object, changed: false }
  const point = pointFor(object)
  const currentTimeMs = Date.parse(at)
  const expired = data.control.inputExpiresAt !== undefined && Date.parse(data.control.inputExpiresAt) < currentTimeMs
  const control = (() => {
    if (!expired || data.control.mode !== 'manual') return data.control
    const { manualAxes: _manualAxes, inputExpiresAt: _inputExpiresAt, inputSource: _inputSource, ...baseControl } = data.control
    return { ...baseControl, mode: 'hold' as const }
  })()
  let targetEastMps = 0
  let targetNorthMps = 0
  let targetVerticalMps = 0
  let targetYawDeg = data.kinematics.yawDeg
  if (control.mode === 'manual' && control.manualAxes) {
    const desired = desiredVelocityManual(data, control.manualAxes)
    targetEastMps = desired.eastMps
    targetNorthMps = desired.northMps
    targetVerticalMps = desired.verticalMps
    targetYawDeg = normalizeAngleDeg(data.kinematics.yawDeg + control.manualAxes.yaw * data.profile.dynamics.maxYawRateDegPerSec * elapsedSeconds)
  }
  if ((control.mode === 'guided' || control.mode === 'swarm' || control.mode === 'return_to_launch') && control.guidedTarget) {
    const desired = desiredVelocityToTarget(point, data, control.guidedTarget)
    targetEastMps = desired.eastMps
    targetNorthMps = desired.northMps
    targetVerticalMps = desired.verticalMps
    targetYawDeg = desired.yawDeg
  }
  if (control.mode === 'land') {
    targetVerticalMps = data.kinematics.altitudeM <= 0.15 ? 0 : -Math.min(data.profile.dynamics.maxVerticalSpeedMps, 2.2)
  }
  const physics = integrateDronePhysics({
    objectId: object.id,
    data,
    target: {
      eastMps: targetEastMps,
      northMps: targetNorthMps,
      verticalMps: targetVerticalMps,
      yawDeg: targetYawDeg,
    },
    environment,
    elapsedSeconds,
    at,
  })
  const nextAltitudeM = clamp(
    data.kinematics.altitudeM + physics.kinematics.verticalSpeedMps * elapsedSeconds,
    data.profile.dynamics.minAltitudeM,
    data.profile.dynamics.serviceCeilingM,
  )
  const nextPoint = movePointByMeters(point, {
    eastM: physics.kinematics.velocityEastMps * elapsedSeconds,
    northM: physics.kinematics.velocityNorthMps * elapsedSeconds,
  })
  const consumedWh = physics.consumedWh
  const remainingWh = Math.max(0, data.energy.remainingWh - consumedWh)
  const lowEnergy = remainingWh <= data.profile.energy.reserveWh
  const nextControl = lowEnergy && control.mode !== 'land' && control.mode !== 'return_to_launch'
    ? { ...control, mode: 'return_to_launch' as const }
    : control
  const nextHealth = remainingWh <= 0
    ? { ...data.health, state: 'disabled' as const, integrity: Math.min(data.health.integrity, 0.2) }
    : data.health
  const nextData: DronePackData = {
    ...data,
    environment,
    control: nextControl,
    kinematics: {
      ...physics.kinematics,
      altitudeM: nextAltitudeM,
      verticalSpeedMps: nextAltitudeM <= data.profile.dynamics.minAltitudeM && physics.kinematics.verticalSpeedMps < 0 ? 0 : physics.kinematics.verticalSpeedMps,
    },
    energy: {
      remainingWh,
      consumedWh: data.energy.consumedWh + consumedWh,
      voltageV: data.profile.energy.nominalVoltageV * Math.max(0.65, remainingWh / data.profile.energy.capacityWh),
    },
    health: nextHealth,
  }
  const changed = (
    horizontalDistanceM(point, nextPoint) > 0.05
    || Math.abs(nextData.kinematics.altitudeM - data.kinematics.altitudeM) > 0.02
    || Math.abs(nextData.energy.remainingWh - data.energy.remainingWh) > 0.005
    || Math.abs(nextData.kinematics.pitchDeg - data.kinematics.pitchDeg) > 0.1
    || Math.abs(nextData.kinematics.rollDeg - data.kinematics.rollDeg) > 0.1
    || nextData.control.mode !== data.control.mode
    || nextData.health.state !== data.health.state
  )
  if (!changed) return { object, changed: false }
  return {
    object: withDronePackData(object, nextData, at, { point: nextPoint }),
    changed: true,
  }
}

export const createDroneSimEngine = (config: {
  readonly controlInstanceId: ControlInstanceId
  readonly objects: ReadonlyArray<OperationalObject>
  readonly profiles?: ReadonlyArray<DroneProfile>
  readonly environment?: DroneEnvironment
  readonly startedAt?: IsoTimestamp
}): DroneSimEngine => {
  const objects = new Map<string, OperationalObject>()
  for (const object of config.objects) {
    if (object.packId !== droneSimPackId) continue
    const restored = parseRestoredDroneObject(object)
    objects.set(restored.id, restored)
  }
  const homePoints = new Map<string, { readonly point: GeoJsonPoint; readonly altitudeM: number }>()
  for (const object of objects.values()) {
    const data = parseDroneObject(object)
    const point = object.spatial.position?.point
    if (data && point) homePoints.set(object.id, { point, altitudeM: data.kinematics.altitudeM })
  }
  const state: DroneEngineState = {
    controlInstanceId: config.controlInstanceId,
    objects,
    profiles: config.profiles ?? defaultDroneProfiles,
    environment: config.environment ?? defaultDroneEnvironment,
    homePoints,
    nextObjectNumber: nextNumberAfter(objects.values()),
    clock: config.startedAt ?? nowIso(),
    lastEmitAtMs: 0,
  }

  const snapshot = (): PackRuntimeSnapshot => ({
    controlInstanceId: state.controlInstanceId,
    objects: [...state.objects.values()],
    capturedAt: state.clock,
  })

  const tick = (elapsedMs = defaultTickMs, at = nowIso()): ReadonlyArray<PackRuntimeEvent> => {
    state.clock = at
    const elapsedSeconds = Math.max(0, elapsedMs) / 1000
    if (elapsedSeconds <= 0) return []
    const events: PackRuntimeEvent[] = []
    const emitAllowed = Date.parse(at) - state.lastEmitAtMs >= emitMinIntervalMs
    for (const object of [...state.objects.values()]) {
      const data = parseDroneObject(object)
      if (!data) continue
      const integrated = integrateDrone(object, data, elapsedSeconds, at, state.environment)
      if (!integrated.changed) continue
      updateObject(state, integrated.object)
      if (emitAllowed) events.push(packRuntimeObjectEvent(integrated.object, at))
    }
    if (events.length > 0) state.lastEmitAtMs = Date.parse(at)
    return events
  }

  const handleCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
    const acceptedAt = operationalCommandTime()
    try {
      if (command.kind === createDroneCommandKind) {
        handleCreateDrone(state, command, acceptedAt)
        return commandResultOk(command, acceptedAt)
      }
      if (command.kind === manualControlCommandKind) {
        applyManualControl(state, command, acceptedAt)
        return commandResultOk(command, acceptedAt)
      }
      if (command.kind === navigateDroneCommandKind) {
        applyNavigate(state, command, acceptedAt)
        return commandResultOk(command, acceptedAt)
      }
      if (command.kind === setDroneModeCommandKind) {
        applyMode(state, command, acceptedAt)
        return commandResultOk(command, acceptedAt)
      }
      if (command.kind === configureDroneProfileCommandKind) {
        applyProfile(state, command, acceptedAt)
        return commandResultOk(command, acceptedAt)
      }
      if (command.kind === swarmCommandKind) {
        applySwarmCommand(state, command, acceptedAt)
        return commandResultOk(command, acceptedAt)
      }
      if (command.kind === attackCommandKind) {
        const payload = attackPayloadSchema.parse(command.payload)
        requireDrone(state, payload.attackerId)
        return commandResultOk(command, acceptedAt)
      }
      return commandResultRejected(command, acceptedAt, `drone runtime does not accept command kind: ${command.kind}`)
    } catch (err) {
      return commandResultRejected(command, acceptedAt, err instanceof Error ? err.message : String(err))
    }
  }

  const commandEvents = (command: CommandEnvelope, result: CommandResult): ReadonlyArray<PackRuntimeEvent> => {
    if (!result.ok) return []
    const at = result.acceptedAt
    if (command.kind === attackCommandKind) {
      const payload = attackPayloadSchema.parse(command.payload)
      return [{
        type: 'interaction.signal',
        signal: droneAttackSignal({
          controlInstanceId: state.controlInstanceId,
          at,
          attackerId: payload.attackerId,
          targetId: payload.targetId,
          ...(payload.payloadId === undefined ? {} : { payloadId: payload.payloadId }),
          causationId: command.id,
        }),
        at,
        provenance: {
          source: 'simulator',
          adapterId: droneSimAdapterId,
          externalId: payload.attackerId,
          causedByCommandId: command.id,
        },
      }]
    }
    return [...state.objects.values()]
      .filter(object => command.targetObjectIds.length === 0 || command.targetObjectIds.includes(object.id))
      .map(object => packRuntimeObjectEvent(object, at))
  }

  const observeCommittedEvents = (events: ReadonlyArray<ControlInstanceEvent>): void => {
    for (const event of events) {
      if (event.type === 'object.upserted' && event.object.packId === droneSimPackId) {
        const restored = parseRestoredDroneObject(event.object)
        state.objects.set(restored.id, restored)
      }
      if (event.type === 'object.deleted') {
        state.objects.delete(event.objectId)
        state.homePoints.delete(event.objectId)
      }
    }
  }

  return {
    snapshot,
    tick,
    handleCommand: async (command: CommandEnvelope): Promise<{
      readonly result: CommandResult
      readonly events: ReadonlyArray<PackRuntimeEvent>
    }> => {
      const result = await handleCommand(command)
      return {
        result,
        events: commandEvents(command, result),
      }
    },
    observeCommittedEvents,
  }
}
