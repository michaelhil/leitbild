import {
  interactionSignalSchema,
  notificationIdSchema,
  type InteractionEffect,
  type InteractionHandler,
  type InteractionSignal,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type SignalId,
} from '../../core/model/index.ts'
import { attackPayloadSchema } from './commands.ts'
import { dronePackDataSchema, dronePackId, type DroneDamageRecord, type DronePackData } from './model.ts'
import { offsetMeters } from './spatial.ts'

export const droneAttackRequestedSignalType = 'drone.attack.requested'

export const droneAttackSignalPayloadSchema = attackPayloadSchema

const randomId = (): string => globalThis.crypto.randomUUID()

const pointFor = (object: OperationalObject) =>
  object.spatial.position?.point ?? (object.spatial.geometry?.type === 'Point' ? object.spatial.geometry : null)

const horizontalDistanceM = (left: OperationalObject, right: OperationalObject): number => {
  const leftPoint = pointFor(left)
  const rightPoint = pointFor(right)
  if (!leftPoint || !rightPoint) return Number.POSITIVE_INFINITY
  const offset = offsetMeters(leftPoint, rightPoint)
  return Math.hypot(offset.eastM, offset.northM)
}

const notification = (
  signal: InteractionSignal,
  title: string,
  message: string,
  severity: 'info' | 'notice' | 'warning' | 'critical',
): InteractionEffect => ({
  type: 'notification.emit',
  notification: {
    id: notificationIdSchema.parse(`notification:drone:${randomId()}`),
    simulationRunId: signal.simulationRunId,
    at: signal.at,
    title,
    message,
    severity,
    source: signal.source,
    targets: signal.targets,
    signalId: signal.id,
  },
})

const withUpdatedDronePackData = (
  object: OperationalObject,
  packData: DronePackData,
  at: IsoTimestamp,
): OperationalObject => ({
  ...object,
  revision: object.revision + 1,
  lifecycle: packData.health.state === 'destroyed' ? 'inactive' : object.lifecycle,
  operational: {
    ...object.operational,
    status: packData.health.state === 'destroyed'
      ? 'destroyed'
      : packData.health.state === 'failed'
        ? 'failed'
        : object.operational.status,
    ...(packData.health.state === 'destroyed' || packData.health.state === 'failed' || packData.health.state === 'critical'
      ? { priority: 'critical' as const }
      : packData.health.state === 'degraded'
        ? { priority: 'high' as const }
        : {}),
  },
  packData,
  timestamps: {
    ...object.timestamps,
    updatedAt: at,
  },
})

const damagedGenericObject = (
  object: OperationalObject,
  config: {
    readonly attackerId: ObjectId
    readonly damage: number
    readonly effectKind: string
    readonly at: IsoTimestamp
  },
): OperationalObject => {
  const destroyed = config.damage >= 0.95
  return {
    ...object,
    revision: object.revision + 1,
    lifecycle: destroyed ? 'inactive' : object.lifecycle,
    operational: {
      ...object.operational,
      status: destroyed ? 'destroyed' : 'damaged',
      priority: destroyed ? 'critical' : 'high',
    },
    alerts: [
      ...object.alerts,
      {
        id: `${object.id}:drone-effect:${randomId()}`,
        kind: 'drone_effect',
        severity: destroyed ? 'critical' : 'warning',
        message: `${destroyed ? 'Destroyed' : 'Damaged'} by drone effect ${config.effectKind}`,
        raisedAt: config.at,
        acknowledged: false,
      },
    ],
    provenance: {
      source: 'simulator',
      externalId: object.id,
    },
    timestamps: {
      ...object.timestamps,
      updatedAt: config.at,
    },
  }
}

const damagedDrone = (
  object: OperationalObject,
  data: DronePackData,
  config: {
    readonly attackerId: ObjectId
    readonly damage: number
    readonly effectKind: string
    readonly at: IsoTimestamp
  },
): OperationalObject => {
  const previousDamage = data.health.damage.reduce((total, record) => total + record.severity, 0)
  const nextIntegrity = Math.max(0, 1 - previousDamage - config.damage)
  const state = nextIntegrity <= 0
    ? 'destroyed'
    : nextIntegrity < 0.28
      ? 'failed'
      : nextIntegrity < 0.72
        ? 'critical'
        : nextIntegrity < 0.9
          ? 'degraded'
          : data.health.state === 'unknown'
            ? 'degraded'
            : 'nominal'
  const damageRecord: DroneDamageRecord = {
    id: `damage:${randomId()}`,
    sourceObjectId: config.attackerId,
    kind: config.effectKind,
    severity: config.damage,
    occurredAt: config.at,
    description: `Drone effect ${config.effectKind} reduced integrity to ${Math.round(nextIntegrity * 100)}%`,
  }
  return withUpdatedDronePackData(object, {
    ...data,
    health: {
      ...data.health,
      state,
      damage: [...data.health.damage, damageRecord],
    },
  }, config.at)
}

export const createDroneAttackInteractionHandler = (): InteractionHandler => ({
  id: 'drone.attack-effects',
  priority: 80,
  accepts: (signal: InteractionSignal): boolean => signal.type === droneAttackRequestedSignalType,
  handle: async ({ signal, snapshot }): Promise<ReadonlyArray<InteractionEffect>> => {
    const payload = droneAttackSignalPayloadSchema.parse(signal.payload)
    const attacker = snapshot.objects.find(object => object.id === payload.attackerId)
    const target = snapshot.objects.find(object => object.id === payload.targetId)
    if (!attacker) return [notification(signal, 'Drone attack rejected', `Unknown attacker ${payload.attackerId}`, 'warning')]
    if (!target) return [notification(signal, 'Drone attack rejected', `Unknown target ${payload.targetId}`, 'warning')]
    const attackerData = dronePackDataSchema.safeParse(attacker.packData)
    if (!attackerData.success || attacker.packId !== dronePackId) {
      return [notification(signal, 'Drone attack rejected', `${attacker.label} is not a valid drone`, 'warning')]
    }
    const effectPayload = payload.payloadId
      ? attackerData.data.vehicle.payloads.find(candidate => candidate.id === payload.payloadId)
      : attackerData.data.vehicle.payloads.find(candidate => candidate.effect !== undefined)
    if (!effectPayload?.effect) {
      return [notification(signal, 'Drone attack rejected', `${attacker.label} has no effect payload`, 'warning')]
    }
    if (effectPayload.quantity <= 0) {
      return [notification(signal, 'Drone attack rejected', `${effectPayload.label} is depleted`, 'warning')]
    }
    const rangeM = effectPayload.rangeM ?? 0
    const distanceM = horizontalDistanceM(attacker, target)
    if (distanceM > rangeM) {
      return [notification(signal, 'Drone attack rejected', `${target.label} is ${Math.round(distanceM)} m away; ${effectPayload.label} range is ${Math.round(rangeM)} m`, 'warning')]
    }
    const targetDroneData = dronePackDataSchema.safeParse(target.packData)
    const updatedTarget = targetDroneData.success && target.packId === dronePackId
      ? damagedDrone(target, targetDroneData.data, {
          attackerId: payload.attackerId,
          damage: effectPayload.effect.damage,
          effectKind: effectPayload.effect.kind,
          at: signal.at,
        })
      : damagedGenericObject(target, {
          attackerId: payload.attackerId,
          damage: effectPayload.effect.damage,
          effectKind: effectPayload.effect.kind,
          at: signal.at,
        })
    const updatedPayloads = attackerData.data.vehicle.payloads.map(candidate =>
      candidate.id === effectPayload.id
        ? { ...candidate, quantity: Math.max(0, candidate.quantity - 1) }
        : candidate)
    const updatedAttacker = withUpdatedDronePackData(attacker, {
      ...attackerData.data,
      vehicle: {
        ...attackerData.data.vehicle,
        payloads: updatedPayloads,
      },
    }, signal.at)
    return [
      { type: 'object.upsert', object: updatedAttacker },
      { type: 'object.upsert', object: updatedTarget },
      notification(signal, 'Drone effect applied', `${attacker.label} applied ${effectPayload.label} to ${target.label}`, 'notice'),
    ]
  },
})

export const droneAttackSignal = (config: {
  readonly simulationRunId: string
  readonly at: IsoTimestamp
  readonly attackerId: ObjectId
  readonly targetId: ObjectId
  readonly payloadId?: string
  readonly causationId?: string
}): InteractionSignal =>
  interactionSignalSchema.parse({
    id: `signal:${randomId()}` as SignalId,
    simulationRunId: config.simulationRunId,
    at: config.at,
    source: { kind: 'object', id: config.attackerId },
    targets: [{ kind: 'object', id: config.targetId }],
    type: droneAttackRequestedSignalType,
    severity: 'critical',
    payload: {
      attackerId: config.attackerId,
      targetId: config.targetId,
      ...(config.payloadId === undefined ? {} : { payloadId: config.payloadId }),
    },
    ...(config.causationId === undefined ? {} : { causationId: config.causationId }),
  }) as InteractionSignal
