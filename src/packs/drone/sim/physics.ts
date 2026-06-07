import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { DroneEnvironment, DroneKinematics, DronePackData } from '../model.ts'
import { clamp, limitRate, normalizeAngleDeg, shortestAngleDeltaDeg } from './flight-math.ts'

export interface DroneVelocityTarget {
  readonly eastMps: number
  readonly northMps: number
  readonly verticalMps: number
  readonly yawDeg: number
}

export interface DronePhysicsResult {
  readonly kinematics: DroneKinematics
  readonly consumedWh: number
  readonly airspeedMps: number
  readonly horizontalSpeedMps: number
}

interface WindVector {
  readonly eastMps: number
  readonly northMps: number
}

const gravityMps2 = 9.80665

const payloadMassKg = (data: DronePackData): number =>
  data.profile.payloads.reduce((sum, payload) => sum + payload.massKg * payload.quantity, 0)

const stableHash = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const windVectorFor = (
  environment: DroneEnvironment,
  at: IsoTimestamp,
  seed: string,
): WindVector => {
  const baseRad = environment.windDirectionDeg * Math.PI / 180
  const seedPhase = stableHash(seed) / 0xffffffff * Math.PI * 2
  const timeSeconds = Number.isFinite(Date.parse(at)) ? Date.parse(at) / 1000 : 0
  const gustWave = Math.sin(timeSeconds * 0.41 + seedPhase) * 0.55 + Math.sin(timeSeconds * 0.17 + seedPhase * 1.7) * 0.45
  const gust = environment.gustSpeedMps * environment.turbulenceIntensity * gustWave
  const speed = Math.max(0, environment.windSpeedMps + gust)
  const directionRad = baseRad + environment.turbulenceIntensity * 0.22 * Math.sin(timeSeconds * 0.23 + seedPhase)
  return {
    eastMps: Math.sin(directionRad) * speed,
    northMps: Math.cos(directionRad) * speed,
  }
}

const limitedHorizontalAcceleration = (
  eastMps2: number,
  northMps2: number,
  maxAccelerationMps2: number,
): { readonly eastMps2: number; readonly northMps2: number } => {
  const magnitude = Math.hypot(eastMps2, northMps2)
  if (magnitude <= maxAccelerationMps2 || magnitude <= 0) return { eastMps2, northMps2 }
  const scale = maxAccelerationMps2 / magnitude
  return {
    eastMps2: eastMps2 * scale,
    northMps2: northMps2 * scale,
  }
}

const limitedHorizontalVelocity = (
  eastMps: number,
  northMps: number,
  maxHorizontalSpeedMps: number,
): { readonly eastMps: number; readonly northMps: number } => {
  const magnitude = Math.hypot(eastMps, northMps)
  if (magnitude <= maxHorizontalSpeedMps || magnitude <= 0) return { eastMps, northMps }
  const scale = maxHorizontalSpeedMps / magnitude
  return {
    eastMps: eastMps * scale,
    northMps: northMps * scale,
  }
}

const dragAcceleration = (
  data: DronePackData,
  environment: DroneEnvironment,
  airEastMps: number,
  airNorthMps: number,
): { readonly eastMps2: number; readonly northMps2: number } => {
  const airspeedMps = Math.hypot(airEastMps, airNorthMps)
  if (airspeedMps <= 0) return { eastMps2: 0, northMps2: 0 }
  const massKg = data.profile.airframe.massKg + payloadMassKg(data)
  const coefficient = 0.5 * environment.airDensityKgM3 * data.profile.airframe.dragAreaM2 / massKg
  return {
    eastMps2: -coefficient * airspeedMps * airEastMps,
    northMps2: -coefficient * airspeedMps * airNorthMps,
  }
}

const energyUseWh = (
  data: DronePackData,
  environment: DroneEnvironment,
  airspeedMps: number,
  verticalSpeedMps: number,
  elapsedSeconds: number,
): number => {
  const maxHorizontalSpeedMps = Math.max(0.1, data.profile.dynamics.maxHorizontalSpeedMps)
  const speedRatio = clamp(airspeedMps / maxHorizontalSpeedMps, 0, 1.8)
  const massKg = data.profile.airframe.massKg + payloadMassKg(data)
  const massFactor = massKg / data.profile.airframe.massKg
  const climbPowerW = verticalSpeedMps > 0
    ? massKg * gravityMps2 * verticalSpeedMps / 0.68
    : 0
  const dragPowerW = 0.5 * environment.airDensityKgM3 * data.profile.airframe.dragAreaM2 * airspeedMps ** 3
  const weatherPenaltyW = data.profile.energy.hoverPowerW * (
    environment.turbulenceIntensity * 0.16
    + environment.precipitationIntensity * (environment.precipitation === 'snow' ? 0.16 : 0.1)
  )
  const cruisePowerW = data.profile.energy.hoverPowerW * massFactor
    + (data.profile.energy.cruisePowerW - data.profile.energy.hoverPowerW) * speedRatio ** 2
    + climbPowerW
    + dragPowerW * 0.45
    + weatherPenaltyW
    + data.profile.energy.payloadPowerW
  return Math.max(0, cruisePowerW) * elapsedSeconds / 3_600
}

export const integrateDronePhysics = (config: {
  readonly objectId: string
  readonly data: DronePackData
  readonly target: DroneVelocityTarget
  readonly environment: DroneEnvironment
  readonly elapsedSeconds: number
  readonly at: IsoTimestamp
}): DronePhysicsResult => {
  const { data, environment, elapsedSeconds, target } = config
  const wind = windVectorFor(environment, config.at, config.objectId)
  const airEastMps = data.kinematics.velocityEastMps - wind.eastMps
  const airNorthMps = data.kinematics.velocityNorthMps - wind.northMps
  const drag = dragAcceleration(data, environment, airEastMps, airNorthMps)
  const gains = data.profile.dynamics.controller
  const velocityEastError = target.eastMps - data.kinematics.velocityEastMps
  const velocityNorthError = target.northMps - data.kinematics.velocityNorthMps
  const weatherResidual = clamp(0.18 + environment.turbulenceIntensity * 0.32, 0.18, 0.58)
  const rawEastAccel = velocityEastError * gains.velocityP
    - data.kinematics.velocityEastMps * gains.damping
    + drag.eastMps2 * weatherResidual
  const rawNorthAccel = velocityNorthError * gains.velocityP
    - data.kinematics.velocityNorthMps * gains.damping
    + drag.northMps2 * weatherResidual
  const acceleration = limitedHorizontalAcceleration(rawEastAccel, rawNorthAccel, data.profile.dynamics.maxAccelerationMps2)
  const unclampedEastMps = clamp(
    data.kinematics.velocityEastMps + acceleration.eastMps2 * elapsedSeconds,
    -data.profile.dynamics.maxHorizontalSpeedMps,
    data.profile.dynamics.maxHorizontalSpeedMps,
  )
  const unclampedNorthMps = clamp(
    data.kinematics.velocityNorthMps + acceleration.northMps2 * elapsedSeconds,
    -data.profile.dynamics.maxHorizontalSpeedMps,
    data.profile.dynamics.maxHorizontalSpeedMps,
  )
  const nextHorizontalVelocity = limitedHorizontalVelocity(
    unclampedEastMps,
    unclampedNorthMps,
    data.profile.dynamics.maxHorizontalSpeedMps,
  )
  const nextEastMps = nextHorizontalVelocity.eastMps
  const nextNorthMps = nextHorizontalVelocity.northMps
  const maxVerticalDelta = data.profile.dynamics.maxAccelerationMps2 * elapsedSeconds
  const nextVerticalMps = limitRate(data.kinematics.verticalSpeedMps, target.verticalMps, maxVerticalDelta)
  const nextYawDeg = normalizeAngleDeg(data.kinematics.yawDeg + clamp(
    shortestAngleDeltaDeg(data.kinematics.yawDeg, target.yawDeg) * gains.yawP,
    -data.profile.dynamics.maxYawRateDegPerSec * elapsedSeconds,
    data.profile.dynamics.maxYawRateDegPerSec * elapsedSeconds,
  ))
  const horizontalSpeedMps = Math.hypot(nextEastMps, nextNorthMps)
  const nextAirEastMps = nextEastMps - wind.eastMps
  const nextAirNorthMps = nextNorthMps - wind.northMps
  const airspeedMps = Math.hypot(nextAirEastMps, nextAirNorthMps)
  const pitchDeg = clamp(
    -acceleration.northMps2 / gravityMps2 * 180 / Math.PI,
    -data.profile.dynamics.maxTiltDeg,
    data.profile.dynamics.maxTiltDeg,
  )
  const rollDeg = clamp(
    acceleration.eastMps2 / gravityMps2 * 180 / Math.PI,
    -data.profile.dynamics.maxTiltDeg,
    data.profile.dynamics.maxTiltDeg,
  )
  return {
    kinematics: {
      altitudeM: data.kinematics.altitudeM,
      verticalSpeedMps: nextVerticalMps,
      velocityEastMps: nextEastMps,
      velocityNorthMps: nextNorthMps,
      yawDeg: nextYawDeg,
      pitchDeg,
      rollDeg,
    },
    consumedWh: energyUseWh(data, environment, airspeedMps, nextVerticalMps, elapsedSeconds),
    airspeedMps,
    horizontalSpeedMps,
  }
}
