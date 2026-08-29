import type { DroneSceneCameraOrbit } from './drone-scene-types.ts'

export interface DroneCameraOrbitInput {
  readonly orbitLeft: boolean
  readonly orbitRight: boolean
  readonly orbitUp: boolean
  readonly orbitDown: boolean
  readonly zoomModifier: boolean
}

export interface DroneCameraOrbitRates {
  readonly yawRadPerSec: number
  readonly pitchRadPerSec: number
  readonly zoomMPerSec: number
}

const cameraClamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export const defaultDroneCameraOrbitRates: DroneCameraOrbitRates = {
  yawRadPerSec: 0.92,
  pitchRadPerSec: 0.68,
  zoomMPerSec: 58,
}

export const advanceDroneCameraOrbit = (
  orbit: DroneSceneCameraOrbit,
  input: DroneCameraOrbitInput,
  dtSeconds: number,
  rates: DroneCameraOrbitRates = defaultDroneCameraOrbitRates,
): DroneSceneCameraOrbit => {
  const safeDtSeconds = cameraClamp(dtSeconds, 0, 0.05)
  const horizontalInput = (input.orbitRight ? 1 : 0) + (input.orbitLeft ? -1 : 0)
  const verticalInput = (input.orbitUp ? 1 : 0) + (input.orbitDown ? -1 : 0)
  return {
    yawOffsetRad: orbit.yawOffsetRad + horizontalInput * rates.yawRadPerSec * safeDtSeconds,
    pitchOffsetRad: input.zoomModifier
      ? orbit.pitchOffsetRad
      : cameraClamp(orbit.pitchOffsetRad + verticalInput * rates.pitchRadPerSec * safeDtSeconds, -0.05, 1.12),
    distanceM: input.zoomModifier
      ? cameraClamp(orbit.distanceM - verticalInput * rates.zoomMPerSec * safeDtSeconds, 16, 240)
      : orbit.distanceM,
  }
}
