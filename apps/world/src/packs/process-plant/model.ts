import { z } from 'zod'
import { idSchema, isoTimestampSchema, type IsoTimestamp } from '../../core/model/index.ts'

export const processPlantPackId = 'process-plant' as const

export const processPlantUnitProjectionFieldSchema = z.object({
  key: idSchema,
  label: z.string().min(1),
  value: z.string().min(1),
}).strict()
export type ProcessPlantUnitProjectionField = z.infer<typeof processPlantUnitProjectionFieldSchema>

export const processPlantUnitProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().min(1),
  statusTone: z.enum(['ready', 'working', 'error', 'idle']),
  statusLabel: z.string().min(1),
  highestSeverity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
  activeAlarmCount: z.number().int().nonnegative(),
  activeTripCount: z.number().int().nonnegative(),
  fields: z.array(processPlantUnitProjectionFieldSchema),
  updatedAt: isoTimestampSchema,
}).strict()
export type ProcessPlantUnitProjection = z.infer<typeof processPlantUnitProjectionSchema>

export const processPlantUnitPackDataSchema = z.object({
  type: z.literal('process-plant-unit'),
  schemaVersion: z.literal(1),
  systemId: idSchema,
  clusterId: idSchema.optional(),
  coolingWater: z.string().min(1).optional(),
  projection: processPlantUnitProjectionSchema.optional(),
}).strict()
export type ProcessPlantUnitPackData = z.infer<typeof processPlantUnitPackDataSchema>

export const processPlantField = (
  key: string,
  label: string,
  value: string,
): ProcessPlantUnitProjectionField => ({
  key,
  label,
  value,
})

export const emptyProcessPlantProjection = (at: IsoTimestamp): ProcessPlantUnitProjection => ({
  schemaVersion: 1,
  summary: 'Process runtime pending',
  statusTone: 'idle',
  statusLabel: 'Runtime pending',
  activeAlarmCount: 0,
  activeTripCount: 0,
  fields: [
    processPlantField('runtime', 'Runtime', 'pending'),
  ],
  updatedAt: at,
})
