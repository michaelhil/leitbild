import type { GeoJsonPoint, GeoJsonPolygon, IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { DroneMissionItem } from '../commands.ts'
import {
  droneGuidedTargetSchema,
  dronePackDataSchema,
  type DroneGuidedTarget,
  type DroneManualAxes,
  type DronePackData,
} from '../model.ts'
import { bearingDeg, horizontalDistanceM, movePointByMeters, normalizeAngleDeg, offsetMeters, shortestAngleDeltaDeg } from '../spatial.ts'
import type { DroneNativeRuntimeConfig } from './config.ts'
import { withDronePackData } from './object-state.ts'

export interface NativeMissionPlan {
  readonly planId?: string | undefined
  readonly items: ReadonlyArray<DroneMissionItem>
  currentIndex: number
  holdUntilMs?: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const deadband = (value: number, threshold = 0.01): number =>
  Math.abs(value) < threshold ? 0 : value

const pointInPolygon = (point: GeoJsonPoint, polygon: GeoJsonPolygon): boolean => {
  const ring = polygon.coordinates[0] ?? []
  if (ring.length < 4) return false
  const [x, y] = point.coordinates
  let inside = false
  for (let left = 0, right = ring.length - 1; left < ring.length; right = left, left += 1) {
    const [xLeft, yLeft] = ring[left]!
    const [xRight, yRight] = ring[right]!
    const intersects = ((yLeft > y) !== (yRight > y))
      && x < (xRight - xLeft) * (y - yLeft) / ((yRight - yLeft) || Number.EPSILON) + xLeft
    if (intersects) inside = !inside
  }
  return inside
}

export const targetInsideGeofence = (
  target: GeoJsonPoint,
  polygons: ReadonlyArray<GeoJsonPolygon> | undefined,
): boolean =>
  polygons === undefined || polygons.length === 0 || polygons.some(polygon => pointInPolygon(target, polygon))

const desiredManualVelocity = (
  data: DronePackData,
  axes: DroneManualAxes,
): {
  readonly eastMps: number
  readonly northMps: number
  readonly downMps: number
} => {
  const headingRad = data.pose.headingDeg * Math.PI / 180
  const forwardMps = axes.forward * data.vehicle.flightEnvelope.maxHorizontalSpeedMps
  const rightMps = axes.right * data.vehicle.flightEnvelope.maxHorizontalSpeedMps
  return {
    northMps: forwardMps * Math.cos(headingRad) - rightMps * Math.sin(headingRad),
    eastMps: forwardMps * Math.sin(headingRad) + rightMps * Math.cos(headingRad),
    downMps: -axes.vertical * data.vehicle.flightEnvelope.maxVerticalSpeedMps,
  }
}

const limitVelocityChange = (
  current: number,
  target: number,
  maxDelta: number,
): number => {
  const delta = target - current
  return current + clamp(delta, -maxDelta, maxDelta)
}

const guidedVelocity = (
  data: DronePackData,
  target: DroneGuidedTarget,
): {
  readonly eastMps: number
  readonly northMps: number
  readonly downMps: number
  readonly arrived: boolean
  readonly targetHeadingDeg: number
} => {
  const horizontalDistance = horizontalDistanceM(data.pose.point, target.point)
  const altitudeError = target.altitudeM - data.pose.altitudeM
  const arrivalRadiusM = data.vehicle.flightEnvelope.arrivalRadiusM
  const arrived = horizontalDistance <= arrivalRadiusM && Math.abs(altitudeError) <= 0.8
  if (arrived) {
    return {
      eastMps: 0,
      northMps: 0,
      downMps: 0,
      arrived,
      targetHeadingDeg: data.pose.headingDeg,
    }
  }
  const offset = offsetMeters(data.pose.point, target.point)
  const horizontalSpeed = clamp(target.speedMps ?? data.vehicle.flightEnvelope.cruiseSpeedMps, 0, data.vehicle.flightEnvelope.maxHorizontalSpeedMps)
  const horizontalScale = horizontalDistance > 0 ? Math.min(1, horizontalDistance / Math.max(1, arrivalRadiusM * 3)) : 0
  const verticalSpeed = clamp(Math.abs(altitudeError) * 0.8, 0, data.vehicle.flightEnvelope.maxVerticalSpeedMps)
  return {
    eastMps: horizontalDistance > 0 ? offset.eastM / horizontalDistance * horizontalSpeed * horizontalScale : 0,
    northMps: horizontalDistance > 0 ? offset.northM / horizontalDistance * horizontalSpeed * horizontalScale : 0,
    downMps: altitudeError === 0 ? 0 : -Math.sign(altitudeError) * verticalSpeed,
    arrived,
    targetHeadingDeg: horizontalDistance > 0.1 ? bearingDeg(data.pose.point, target.point) : data.pose.headingDeg,
  }
}

const updateHeading = (
  currentHeadingDeg: number,
  targetHeadingDeg: number,
  maxYawRateDegPerSec: number,
  dtSeconds: number,
): number => {
  const delta = shortestAngleDeltaDeg(currentHeadingDeg, targetHeadingDeg)
  return normalizeAngleDeg(currentHeadingDeg + clamp(delta, -maxYawRateDegPerSec * dtSeconds, maxYawRateDegPerSec * dtSeconds))
}

const updateVelocity = (
  data: DronePackData,
  desired: {
    readonly eastMps: number
    readonly northMps: number
    readonly downMps: number
  },
  dtSeconds: number,
): DronePackData['velocity'] => {
  const maxDelta = data.vehicle.flightEnvelope.maxAccelerationMps2 * dtSeconds
  const eastMps = deadband(limitVelocityChange(data.velocity.eastMps, desired.eastMps, maxDelta))
  const northMps = deadband(limitVelocityChange(data.velocity.northMps, desired.northMps, maxDelta))
  const downMps = deadband(limitVelocityChange(data.velocity.downMps, desired.downMps, maxDelta))
  return {
    eastMps,
    northMps,
    downMps,
    groundSpeedMps: Math.hypot(eastMps, northMps),
    verticalSpeedMps: -downMps,
  }
}

const bodyVelocityFor = (
  velocity: DronePackData['velocity'],
  headingDeg: number,
): {
  readonly forwardMps: number
  readonly rightMps: number
} => {
  const headingRad = headingDeg * Math.PI / 180
  const cos = Math.cos(headingRad)
  const sin = Math.sin(headingRad)
  return {
    forwardMps: velocity.northMps * cos + velocity.eastMps * sin,
    rightMps: -velocity.northMps * sin + velocity.eastMps * cos,
  }
}

const attitudeForVelocity = (
  data: DronePackData,
  velocity: DronePackData['velocity'],
  headingDeg: number,
  yawRateDegPerSec: number,
): DronePackData['attitude'] => {
  const body = bodyVelocityFor(velocity, headingDeg)
  const maxHorizontalSpeed = Math.max(1, data.vehicle.flightEnvelope.maxHorizontalSpeedMps)
  return {
    rollDeg: clamp(body.rightMps / maxHorizontalSpeed * 24, -35, 35),
    pitchDeg: clamp(-body.forwardMps / maxHorizontalSpeed * 20, -30, 30),
    yawDeg: headingDeg,
    yawRateDegPerSec,
  }
}

export const missionTarget = (item: DroneMissionItem): DroneGuidedTarget => ({
  point: item.point,
  altitudeM: item.altitudeM,
  ...(item.speedMps === undefined ? {} : { speedMps: item.speedMps }),
})

export const nativeGuidedTarget = (target: {
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly speedMps?: number | undefined
  readonly targetObjectId?: ObjectId | undefined
}): DroneGuidedTarget =>
  droneGuidedTargetSchema.parse(target)

export const setDroneNavigation = (
  data: DronePackData,
  kind: DronePackData['navigation']['kind'],
  mode: string,
  at: IsoTimestamp,
): DronePackData => ({
  ...data,
  navigation: {
    kind,
    mode,
    updatedAt: at,
  },
})

export const stepDroneObject = (input: {
  readonly object: OperationalObject
  readonly data: DronePackData
  readonly nowMs: number
  readonly dtSeconds: number
  readonly at: IsoTimestamp
  readonly runtimeConfig: DroneNativeRuntimeConfig
  readonly missionPlans: Map<string, NativeMissionPlan>
  readonly geofences: ReadonlyMap<string, ReadonlyArray<GeoJsonPolygon>>
}): OperationalObject => {
  const { object, data, nowMs, dtSeconds, at, runtimeConfig, missionPlans, geofences } = input
  let nextData = data
  let desired = { eastMps: 0, northMps: 0, downMps: 0 }
  let headingTargetDeg = data.pose.headingDeg
  let arrived = false

  const inputExpiresAtMs = data.control.inputExpiresAt === undefined ? 0 : Date.parse(data.control.inputExpiresAt)
  const manualActive = data.navigation.kind === 'manual' && data.control.manualAxes !== undefined && inputExpiresAtMs >= nowMs
  const mission = missionPlans.get(object.id)

  if (manualActive) {
    desired = desiredManualVelocity(data, data.control.manualAxes!)
    headingTargetDeg = normalizeAngleDeg(data.pose.headingDeg + data.control.manualAxes!.yaw * data.vehicle.flightEnvelope.maxYawRateDegPerSec * dtSeconds)
  } else if (!data.arming.armed) {
    desired = { eastMps: 0, northMps: 0, downMps: 0 }
  } else if (mission?.holdUntilMs !== undefined && nowMs < mission.holdUntilMs) {
    desired = { eastMps: 0, northMps: 0, downMps: 0 }
  } else if (mission !== undefined && data.mission.state === 'running') {
    if (mission.holdUntilMs !== undefined && nowMs >= mission.holdUntilMs) delete mission.holdUntilMs
    const item = mission.items[mission.currentIndex]
    if (item) {
      const target = missionTarget(item)
      const guidance = guidedVelocity(data, target)
      desired = guidance
      headingTargetDeg = guidance.targetHeadingDeg
      arrived = guidance.arrived
      if (arrived) {
        if (item.holdSeconds > 0 && mission.holdUntilMs === undefined) {
          mission.holdUntilMs = nowMs + item.holdSeconds * 1_000
        } else if (item.autocontinue) {
          mission.currentIndex += 1
          const nextItem = mission.items[mission.currentIndex]
          nextData = {
            ...nextData,
            control: nextItem === undefined
              ? { ...nextData.control, guidedTarget: undefined }
              : { ...nextData.control, guidedTarget: missionTarget(nextItem), lastCommandAt: at },
            mission: {
              ...nextData.mission,
              state: nextItem === undefined ? 'complete' : 'running',
              currentSeq: nextItem?.seq ?? item.seq,
              total: mission.items.length,
              planId: mission.planId,
              updatedAt: at,
            },
          }
          if (nextItem === undefined) missionPlans.delete(object.id)
        } else {
          nextData = {
            ...nextData,
            mission: {
              ...nextData.mission,
              state: 'paused',
              currentSeq: item.seq,
              total: mission.items.length,
              planId: mission.planId,
              updatedAt: at,
            },
          }
        }
      }
    }
  } else if (data.control.guidedTarget !== undefined && data.navigation.kind !== 'hold') {
    const guidance = guidedVelocity(data, data.control.guidedTarget)
    desired = guidance
    headingTargetDeg = guidance.targetHeadingDeg
    arrived = guidance.arrived
    if (arrived) {
      if (data.navigation.kind === 'land') {
        nextData = {
          ...nextData,
          arming: { state: 'disarmed', armed: false, updatedAt: at },
          control: { ...nextData.control, guidedTarget: undefined },
          pose: {
            ...nextData.pose,
            altitudeM: 0,
            relativeAltitudeM: 0,
            observedAt: at,
          },
          navigation: { kind: 'hold', mode: 'landed', updatedAt: at },
        }
      } else {
        nextData = {
          ...setDroneNavigation(nextData, 'hold', 'hold', at),
          control: { ...nextData.control, guidedTarget: undefined },
        }
      }
    }
  }

  const velocity = updateVelocity(nextData, desired, dtSeconds)
  const nextPoint = movePointByMeters(nextData.pose.point, {
    eastM: velocity.eastMps * dtSeconds,
    northM: velocity.northMps * dtSeconds,
  })
  const nextAltitudeM = clamp(nextData.pose.altitudeM - velocity.downMps * dtSeconds, 0, 100_000)
  const headingDeg = manualActive
    ? headingTargetDeg
    : updateHeading(nextData.pose.headingDeg, headingTargetDeg, nextData.vehicle.flightEnvelope.maxYawRateDegPerSec, dtSeconds)
  const yawRateDegPerSec = dtSeconds > 0
    ? shortestAngleDeltaDeg(nextData.pose.headingDeg, headingDeg) / dtSeconds
    : 0
  const polygons = geofences.get(object.id)
  const breachStatus = polygons === undefined || polygons.length === 0
    ? nextData.geofence.breachStatus
    : targetInsideGeofence(nextPoint, polygons) ? 'clear' : 'breached'
  const drain = (data.arming.armed || manualActive)
    ? runtimeConfig.batteryDrainPercentPerHour * dtSeconds / 3_600 * (1 + Math.min(2, velocity.groundSpeedMps / Math.max(1, data.vehicle.flightEnvelope.cruiseSpeedMps)))
    : 0
  const battery = data.battery.remainingPercent === undefined
    ? data.battery
    : { ...data.battery, remainingPercent: clamp(data.battery.remainingPercent - drain, 0, 100) }

  const updatedData = dronePackDataSchema.parse({
    ...nextData,
    velocity,
    pose: {
      ...nextData.pose,
      point: nextPoint,
      altitudeM: nextAltitudeM,
      relativeAltitudeM: nextAltitudeM,
      headingDeg,
      observedAt: at,
    },
    attitude: attitudeForVelocity(nextData, velocity, headingDeg, yawRateDegPerSec),
    battery,
    link: {
      ...nextData.link,
      state: 'connected',
      lastHeartbeatAt: at,
      lastMessageAt: at,
    },
    geofence: {
      ...nextData.geofence,
      breachStatus,
      updatedAt: breachStatus === nextData.geofence.breachStatus ? nextData.geofence.updatedAt : at,
    },
  })

  return withDronePackData(object, updatedData, at)
}
