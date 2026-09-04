import { z } from 'zod'
import { defaultDroneVehicleModels, droneVehicleModelCatalogSchema, droneVehicleModelSchema } from './model.ts'

export const dronePackConfigSchema = z.object({
  maxDrones: z.number().int().positive().max(500).default(10),
  stepIntervalMs: z.number().int().min(5).max(100).default(20),
  projectionIntervalMs: z.number().int().min(10).max(5_000).default(1_000),
  motionFrameIntervalMs: z.number().int().min(10).max(1_000).default(100),
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()

export const droneModelsForConfig = (config: z.infer<typeof dronePackConfigSchema>) => {
  const models = new Map(defaultDroneVehicleModels.map(model => [model.id, model]))
  for (const model of droneVehicleModelCatalogSchema.parse({ models: config.models }).models) models.set(model.id, model)
  return [...models.values()]
}
