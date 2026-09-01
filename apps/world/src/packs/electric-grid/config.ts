import { z } from 'zod'

export const gridModelSelectionSchema = z.object({
  ref: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
}).strict()
export type GridModelSelection = z.infer<typeof gridModelSelectionSchema>

export const gridOperatingPointSelectionSchema = z.object({
  ref: z.string().min(1),
  parameterOverrides: z.record(z.string(), z.unknown()).optional(),
  valueOverrides: z.record(z.string(), z.unknown()).optional(),
}).strict()
export type GridOperatingPointSelection = z.infer<typeof gridOperatingPointSelectionSchema>

export const gridAutomationSelectionSchema = z.object({
  ref: z.string().min(1),
}).strict()
export type GridAutomationSelection = z.infer<typeof gridAutomationSelectionSchema>

export const gridDefinitionSchema = z.object({
  id: z.string().min(1),
  model: gridModelSelectionSchema,
  operatingPoint: gridOperatingPointSelectionSchema,
  automation: gridAutomationSelectionSchema,
}).strict()
export type GridDefinition = z.infer<typeof gridDefinitionSchema>

/** Grids are authored as Scenario Items. Pack config is intentionally empty. */
export const electricGridPackConfigSchema = z.object({}).strict()
export type ElectricGridPackConfig = z.infer<typeof electricGridPackConfigSchema>
