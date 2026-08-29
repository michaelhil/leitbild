import { z } from 'zod'
import {
  defaultDroneVehicleModels,
  droneVehicleModelCatalogSchema,
  droneVehicleModelSchema,
  type DroneVehicleModel,
} from '../model.ts'

const runtimeConfigSchema = z.object({
  maxDrones: z.number().int().positive().max(500).default(10),
  stepIntervalMs: z.number().int().min(5).max(100).default(20),
  projectionIntervalMs: z.number().int().min(10).max(250).default(33),
  motionFrameIntervalMs: z.number().int().min(10).max(250).default(20),
  batteryDrainPercentPerHour: z.number().finite().nonnegative().max(100).default(8),
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()

export interface DroneNativeRuntimeConfig {
  readonly maxDrones: number
  readonly stepIntervalMs: number
  readonly projectionIntervalMs: number
  readonly motionFrameIntervalMs: number
  readonly batteryDrainPercentPerHour: number
  readonly models: ReadonlyArray<DroneVehicleModel>
}

export const parseDroneNativeRuntimeConfig = (rawConfig: unknown): DroneNativeRuntimeConfig => {
  const parsed = runtimeConfigSchema.parse(rawConfig ?? {})
  const modelById = new Map(defaultDroneVehicleModels.map(model => [model.id, model]))
  for (const model of droneVehicleModelCatalogSchema.parse({ models: parsed.models }).models) {
    modelById.set(model.id, model)
  }
  return {
    maxDrones: parsed.maxDrones,
    stepIntervalMs: parsed.stepIntervalMs,
    projectionIntervalMs: parsed.projectionIntervalMs,
    motionFrameIntervalMs: parsed.motionFrameIntervalMs,
    batteryDrainPercentPerHour: parsed.batteryDrainPercentPerHour,
    models: [...modelById.values()],
  }
}
