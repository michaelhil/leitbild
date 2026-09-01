import { z } from 'zod'
import type { OperationalObject } from '../../core/model/index.ts'
import {
  gridAutomationSelectionSchema,
  gridModelSelectionSchema,
  gridOperatingPointSelectionSchema,
} from './config.ts'

export const electricGridPackId = 'electric-grid' as const

const finiteNumber = z.number().finite()

export const gridProjectionSchema = z.object({
  statusTone: z.enum(['ready', 'working', 'error', 'idle']),
  statusLabel: z.string().min(1),
  summary: z.string().min(1),
  nominalFrequencyHz: finiteNumber.positive(),
  frequencyHz: finiteNumber.positive(),
  totalGenerationMw: finiteNumber.nonnegative(),
  totalLoadMw: finiteNumber.nonnegative(),
  servedLoadMw: finiteNumber.nonnegative(),
  unservedLoadMw: finiteNumber.nonnegative(),
  reserveMarginMw: finiteNumber,
  highestBranchLoadingPercent: finiteNumber.nonnegative(),
  lowestVoltagePu: finiteNumber.positive(),
  activeIslandCount: z.number().int().positive(),
  activeAlarmCount: z.number().int().nonnegative(),
  tick: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
}).strict()
export type GridProjection = z.infer<typeof gridProjectionSchema>

export const electricGridPackDataSchema = z.object({
  type: z.literal('electric-grid'),
  schemaVersion: z.literal(1),
  model: gridModelSelectionSchema,
  operatingPoint: gridOperatingPointSelectionSchema,
  automation: gridAutomationSelectionSchema,
  projection: gridProjectionSchema,
}).strict()
export type ElectricGridPackData = z.infer<typeof electricGridPackDataSchema>

export const emptyGridProjection = (at: string, nominalFrequencyHz: number): GridProjection => ({
  statusTone: 'idle',
  statusLabel: 'Initializing',
  summary: 'Grid runtime is initializing',
  nominalFrequencyHz,
  frequencyHz: nominalFrequencyHz,
  totalGenerationMw: 0,
  totalLoadMw: 0,
  servedLoadMw: 0,
  unservedLoadMw: 0,
  reserveMarginMw: 0,
  highestBranchLoadingPercent: 0,
  lowestVoltagePu: 1,
  activeIslandCount: 1,
  activeAlarmCount: 0,
  tick: 0,
  updatedAt: at,
})

export const parseElectricGridObjectData = (
  object: Pick<OperationalObject, 'packId' | 'packData'>,
): ElectricGridPackData | null => {
  if (object.packId !== electricGridPackId) return null
  const parsed = electricGridPackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

export const gridIdForObject = (
  object: Pick<OperationalObject, 'id' | 'packId' | 'packData'>,
): string | null => parseElectricGridObjectData(object) === null ? null : object.id
