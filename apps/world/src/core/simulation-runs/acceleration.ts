import { z } from 'zod'
import { isoTimestampSchema, simulationRunIdSchema } from '../model/index.ts'

export const accelerationDurationInputSchema = z.object({
  minutes: z.number().finite().positive().max(7 * 24 * 60),
  name: z.string().trim().min(1).max(120).optional(),
}).strict()

export const additionalAccelerationInputSchema = accelerationDurationInputSchema.omit({ name: true })

export const accelerationJobStateSchema = z.object({
  status: z.enum(['running', 'paused', 'completed', 'failed']),
  startedSimulationTime: isoTimestampSchema,
  targetSimulationTime: isoTimestampSchema,
  currentSimulationTime: isoTimestampSchema,
  startedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  activeWallMs: z.number().finite().nonnegative(),
  simulatedMs: z.number().finite().nonnegative(),
  measuredSpeed: z.number().finite().nonnegative(),
  error: z.string().min(1).max(2_000).optional(),
}).strict()

export type AccelerationJobState = z.infer<typeof accelerationJobStateSchema>

export const acceleratedCopyOriginSchema = z.object({
  kind: z.literal('accelerated-copy'),
  sourceRunId: simulationRunIdSchema,
  sourceSequence: z.number().int().nonnegative(),
  forkedAt: isoTimestampSchema,
}).strict()

export type AcceleratedCopyOrigin = z.infer<typeof acceleratedCopyOriginSchema>

export interface SimulationRunForkCheckpoint {
  readonly snapshot: import('./state-store.ts').SimulationRunStateSnapshot
  readonly runtimeStates: Readonly<Record<string, unknown>>
}

export const accelerationStepMs = 250
export const accelerationProgressWallIntervalMs = 100
export const accelerationCheckpointWallIntervalMs = 2_000

