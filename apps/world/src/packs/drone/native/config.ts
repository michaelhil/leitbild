import { droneModelsForConfig,dronePackConfigSchema } from '../config.ts'
import type { DroneVehicleModel } from '../model.ts'

export interface DroneNativeRuntimeConfig {
  readonly maxDrones: number
  readonly stepIntervalMs: number
  readonly projectionIntervalMs: number
  readonly motionFrameIntervalMs: number
  readonly batteryDrainPercentPerHour: number
  readonly models: ReadonlyArray<DroneVehicleModel>
}

export const parseDroneNativeRuntimeConfig = (rawConfig: unknown): DroneNativeRuntimeConfig => {
  const parsed = dronePackConfigSchema.parse(rawConfig ?? {})
  return {
    maxDrones: parsed.maxDrones,
    stepIntervalMs: parsed.stepIntervalMs,
    projectionIntervalMs: parsed.projectionIntervalMs,
    motionFrameIntervalMs: parsed.motionFrameIntervalMs,
    batteryDrainPercentPerHour: parsed.batteryDrainPercentPerHour,
    models: droneModelsForConfig(parsed),
  }
}
