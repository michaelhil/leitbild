import type { CommandEnvelope, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject, TelemetryState } from '../../../core/model/index.ts'
import { meters } from '../../../core/model/index.ts'
import {
  dronePackDataSchema,
  type DroneControlState,
  type DroneHealthStateData,
  type DroneKinematics,
  type DronePackData,
  type DroneProfile,
  type DroneSwarmMembership,
} from '../model.ts'
import { droneSimAdapterId, droneSimPackId } from './constants.ts'

const telemetrySignal = (config: {
  readonly at: IsoTimestamp
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly value: number
  readonly severity?: 'normal' | 'warning' | 'critical'
}): TelemetryState['signals'][string] => ({
  signalId: config.id,
  label: config.label,
  unit: config.unit,
  latest: config.value,
  samples: [{ at: config.at, value: config.value }],
  severity: config.severity ?? 'normal',
})

export const droneTelemetry = (data: DronePackData, at: IsoTimestamp): TelemetryState => {
  const batteryPercent = data.energy.remainingWh / data.profile.energy.capacityWh * 100
  const speedMps = Math.hypot(data.kinematics.velocityEastMps, data.kinematics.velocityNorthMps)
  return {
    signals: {
      altitude: telemetrySignal({ at, id: 'altitude', label: 'Altitude', unit: 'm', value: data.kinematics.altitudeM }),
      speed: telemetrySignal({ at, id: 'speed', label: 'Ground speed', unit: 'm/s', value: speedMps }),
      verticalSpeed: telemetrySignal({ at, id: 'verticalSpeed', label: 'Vertical speed', unit: 'm/s', value: data.kinematics.verticalSpeedMps }),
      battery: telemetrySignal({
        at,
        id: 'battery',
        label: 'Battery',
        unit: '%',
        value: batteryPercent,
        severity: batteryPercent < 15 ? 'critical' : batteryPercent < 30 ? 'warning' : 'normal',
      }),
      integrity: telemetrySignal({
        at,
        id: 'integrity',
        label: 'Integrity',
        unit: '%',
        value: data.health.integrity * 100,
        severity: data.health.integrity < 0.28 ? 'critical' : data.health.integrity < 0.72 ? 'warning' : 'normal',
      }),
    },
  }
}

export const operationalStatusForDrone = (data: DronePackData): OperationalObject['operational'] => {
  const lowEnergy = data.energy.remainingWh <= data.profile.energy.reserveWh
  if (data.health.state === 'destroyed') return { status: 'destroyed', priority: 'critical', mode: 'simulated' }
  if (data.health.state === 'disabled') return { status: 'disabled', priority: 'critical', mode: 'simulated' }
  if (lowEnergy) return { status: 'low_battery', priority: 'high', intent: data.control.mode, mode: 'simulated' }
  return {
    status: data.control.mode,
    priority: data.health.state === 'degraded' ? 'high' : 'normal',
    intent: data.control.mode,
    mode: 'simulated',
  }
}

export const createDronePackData = (config: {
  readonly profile: DroneProfile
  readonly altitudeM: number
  readonly headingDeg: number
  readonly at: IsoTimestamp
  readonly mode?: DroneControlState['mode']
  readonly swarm?: DroneSwarmMembership
}): DronePackData =>
  dronePackDataSchema.parse({
    type: 'drone',
    schemaVersion: 1,
    profile: config.profile,
    kinematics: {
      altitudeM: config.altitudeM,
      verticalSpeedMps: 0,
      velocityEastMps: 0,
      velocityNorthMps: 0,
      yawDeg: config.headingDeg,
      pitchDeg: 0,
      rollDeg: 0,
    } satisfies DroneKinematics,
    energy: {
      remainingWh: config.profile.energy.capacityWh,
      consumedWh: 0,
      voltageV: config.profile.energy.nominalVoltageV,
    },
    control: {
      mode: config.mode ?? 'hold',
      lastCommandAt: config.at,
    },
    health: {
      state: 'nominal',
      integrity: 1,
      damage: [],
    } satisfies DroneHealthStateData,
    ...(config.swarm === undefined ? {} : { swarm: config.swarm }),
  })

export const createScenarioDroneObject = (config: {
  readonly id: ObjectId
  readonly label: string
  readonly point: GeoJsonPoint
  readonly profile: DroneProfile
  readonly altitudeM: number
  readonly headingDeg: number
  readonly at: IsoTimestamp
  readonly mode?: DroneControlState['mode']
  readonly swarm?: DroneSwarmMembership
  readonly causedByCommandId?: CommandEnvelope['id']
}): OperationalObject => {
  const data = createDronePackData(config)
  return {
    id: config.id,
    kind: 'mobile_entity',
    packId: droneSimPackId,
    label: config.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: config.point,
        headingDeg: data.kinematics.yawDeg,
        speedMps: 0,
        accuracyM: meters(2),
        observedAt: config.at,
        staleAfterMs: 2_000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: operationalStatusForDrone(data),
    telemetry: droneTelemetry(data, config.at),
    alerts: [],
    communication: {
      state: 'connected',
      lastContactAt: config.at,
    },
    provenance: {
      source: config.causedByCommandId ? 'operator' : 'simulator',
      adapterId: droneSimAdapterId,
      externalId: config.id,
      ...(config.causedByCommandId === undefined ? {} : { causedByCommandId: config.causedByCommandId }),
    },
    timestamps: {
      createdAt: config.at,
      updatedAt: config.at,
    },
    packData: data,
  }
}

export const parseDroneObject = (object: OperationalObject): DronePackData | null => {
  if (object.packId !== droneSimPackId) return null
  const parsed = dronePackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

export const withDronePackData = (
  object: OperationalObject,
  data: DronePackData,
  at: IsoTimestamp,
  config: {
    readonly point?: GeoJsonPoint
    readonly causedByCommandId?: CommandEnvelope['id']
  } = {},
): OperationalObject => {
  const point = config.point ?? object.spatial.position?.point
  if (!point) throw new Error(`cannot update drone ${object.id}: missing position`)
  return {
    ...object,
    revision: object.revision + 1,
    lifecycle: data.health.state === 'destroyed' ? 'inactive' : object.lifecycle,
    spatial: {
      ...object.spatial,
      position: {
        point,
        headingDeg: data.kinematics.yawDeg,
        speedMps: Math.hypot(data.kinematics.velocityEastMps, data.kinematics.velocityNorthMps),
        accuracyM: meters(2),
        observedAt: at,
        staleAfterMs: 2_000,
      },
    },
    operational: operationalStatusForDrone(data),
    telemetry: droneTelemetry(data, at),
    provenance: {
      source: config.causedByCommandId ? 'operator' : 'simulator',
      adapterId: droneSimAdapterId,
      externalId: object.id,
      ...(config.causedByCommandId === undefined ? {} : { causedByCommandId: config.causedByCommandId }),
    },
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
    packData: data,
  }
}
