import { z } from 'zod'

export type IsoTimestamp = string & { readonly __brand: 'IsoTimestamp' }

export const isoTimestampSchema = z.string().datetime().transform(value => value as IsoTimestamp)

export const nowIso = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp

export interface SimulationClockState {
  readonly currentTime: IsoTimestamp
  readonly updatedAt: IsoTimestamp
  readonly paused: boolean
  readonly speed: number
}

export interface SimulationClockUpdate {
  readonly paused?: boolean
  readonly speed?: number
  readonly currentTime?: IsoTimestamp
}

export const simulationClockStateSchema = z.object({
  currentTime: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  paused: z.boolean(),
  speed: z.number().finite().positive(),
})

export const simulationClockUpdateSchema = z.object({
  paused: z.boolean().optional(),
  speed: z.number().finite().positive().optional(),
  currentTime: isoTimestampSchema.optional(),
}).strict()
