import { z } from 'zod'

export const processPlantModelSelectionSchema = z.object({
  ref: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
}).strict()
export type ProcessPlantModelSelection = z.infer<typeof processPlantModelSelectionSchema>

export const processPlantOperatingPointSelectionSchema = z.object({
  ref: z.string().min(1),
  parameterOverrides: z.record(z.string(), z.unknown()).optional(),
  valueOverrides: z.record(z.string(), z.unknown()).optional(),
}).strict()
export type ProcessPlantOperatingPointSelection = z.infer<typeof processPlantOperatingPointSelectionSchema>

export const processPlantAutomationSelectionSchema = z.object({
  ref: z.string().min(1),
}).strict()
export type ProcessPlantAutomationSelection = z.infer<typeof processPlantAutomationSelectionSchema>

export const processPlantDefinitionSchema = z.object({
  id: z.string().min(1),
  model: processPlantModelSelectionSchema,
  operatingPoint: processPlantOperatingPointSelectionSchema,
  automation: processPlantAutomationSelectionSchema,
}).strict()
export type ProcessPlantDefinition = z.infer<typeof processPlantDefinitionSchema>

/** Process Plants are authored as Scenario Items. Pack config is intentionally empty. */
export const processPlantPackConfigSchema = z.object({}).strict()
export type ProcessPlantPackConfig = z.infer<typeof processPlantPackConfigSchema>
