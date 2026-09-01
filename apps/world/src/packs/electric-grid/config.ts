import { z } from 'zod'

export const gridModelSelectionSchema = z.object({
  ref: z.string().min(1),
}).strict()
export type GridModelSelection = z.infer<typeof gridModelSelectionSchema>

export const gridOperatingPointOverridesSchema = z.object({
  loadScale: z.number().finite().positive().optional(),
  generationAvailabilityScale: z.number().finite().nonnegative().optional(),
  storageStateOfCharge: z.number().finite().min(0).max(1).optional(),
}).strict()
export type GridOperatingPointOverrides = z.infer<typeof gridOperatingPointOverridesSchema>

export const gridOperatingPointSelectionSchema = z.object({
  ref: z.string().min(1),
  overrides: gridOperatingPointOverridesSchema.optional(),
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
