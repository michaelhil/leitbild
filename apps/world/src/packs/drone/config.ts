import { z } from 'zod'
import { defaultDroneVehicleModels, droneVehicleModelCatalogSchema, droneVehicleModelSchema } from './model.ts'

export const dronePackConfigSchema = z.object({
  maxDrones: z.number().int().positive().max(500).default(10).describe('Maximum admitted aircraft count in this Run. Changing the Pack limit requires a new Scenario Revision and Run.'),
  stepIntervalMs: z.number().int().min(5).max(100).default(20).describe('Fixed mechanics step and scheduler interval in milliseconds. Simulation time drives catch-up; smaller steps increase work. Requires a new Scenario Revision and Run.'),
  projectionIntervalMs: z.number().int().min(10).max(5_000).default(1_000).describe('Minimum milliseconds between ordinary canonical status projections. Commands still commit their results. Smaller intervals increase projection work; requires a new Scenario Revision and Run.'),
  motionFrameIntervalMs: z.number().int().min(10).max(1_000).default(100).describe('Minimum milliseconds between transient motion frames. Presentation transport cadence, not a separate physics clock. Requires a new Scenario Revision and Run.'),
  models: z.array(droneVehicleModelSchema).default([]).describe('Additional vehicle models; matching ids override built-in choices for initial selection. Per-vehicle live replacement uses world.drone.configure-vehicle-model, not a Pack configuration edit.'),
}).strict()

export const droneModelsForConfig = (config: z.infer<typeof dronePackConfigSchema>) => {
  const models = new Map(defaultDroneVehicleModels.map(model => [model.id, model]))
  for (const model of droneVehicleModelCatalogSchema.parse({ models: config.models }).models) models.set(model.id, model)
  return [...models.values()]
}
