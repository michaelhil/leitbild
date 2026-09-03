import { z } from 'zod'
import { isoTimestampSchema, simulationRunIdSchema } from '../model/index.ts'

export const executionModeSchema = z.enum(['paused', 'realtime', 'fast-forward'])
export const advanceCompletionModeSchema = z.enum(['paused', 'realtime'])

export const executionSetInputSchema = z.object({
  mode: executionModeSchema,
}).strict()

export const executionAdvanceInputSchema = z.object({
  minutes: z.number().finite().positive().max(7 * 24 * 60),
  onComplete: advanceCompletionModeSchema.default('paused'),
}).strict()

export const runCopyInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
}).strict()

export const fastForwardStateSchema = z.object({
  kind: z.enum(['continuous', 'timed']),
  status: z.enum(['running', 'stopped', 'completed', 'failed']),
  startedSimulationTime: isoTimestampSchema,
  targetSimulationTime: isoTimestampSchema.optional(),
  currentSimulationTime: isoTimestampSchema,
  onComplete: advanceCompletionModeSchema,
  startedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  activeWallMs: z.number().finite().nonnegative(),
  simulatedMs: z.number().finite().nonnegative(),
  measuredSpeed: z.number().finite().nonnegative(),
  error: z.string().min(1).max(2_000).optional(),
}).strict()

export const runExecutionStateSchema = z.object({
  mode: executionModeSchema,
  currentSimulationTime: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  fastForward: fastForwardStateSchema.nullable(),
}).strict()

export type ExecutionMode = z.infer<typeof executionModeSchema>
export type AdvanceCompletionMode = z.infer<typeof advanceCompletionModeSchema>
export type FastForwardState = z.infer<typeof fastForwardStateSchema>
export type RunExecutionState = z.infer<typeof runExecutionStateSchema>

export const runCopyOriginSchema = z.object({
  kind: z.literal('copy'),
  familyId: simulationRunIdSchema,
  copyNumber: z.number().int().positive(),
  sourceRunId: simulationRunIdSchema,
  sourceSequence: z.number().int().nonnegative(),
  copiedAt: isoTimestampSchema,
}).strict()

export type RunCopyOrigin = z.infer<typeof runCopyOriginSchema>

export interface SimulationRunCopyCheckpoint {
  readonly snapshot: import('./state-store.ts').SimulationRunStateSnapshot
  readonly runtimeStates: Readonly<Record<string, unknown>>
}

// Pack-internal solvers retain their own fixed timesteps. A one-second Run
// boundary avoids repeating projection and cross-Pack reconciliation four times
// per simulated second while keeping commands, pauses, and coupled state
// observable at the platform's normal update cadence.
export const fastForwardStepMs = 1_000
export const fastForwardProgressWallIntervalMs = 100
export const executionCheckpointWallIntervalMs = 2_000
