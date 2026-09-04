import { z } from 'zod'
import { isoTimestampSchema, simulationRunIdSchema } from '../model/index.ts'

export const runPlaybackSchema = z.enum(['playing', 'paused'])
export const runPaceSchema = z.enum(['realtime', 'maximum'])
export const advanceCompletionSchema = z.enum(['pause', 'play-realtime'])

export const executionSetInputSchema = z.object({
  playback: runPlaybackSchema.optional(),
  pace: runPaceSchema.optional(),
}).strict().refine(input => input.playback !== undefined || input.pace !== undefined, {
  message: 'playback or pace is required',
})

export const executionAdvanceInputSchema = z.object({
  minutes: z.number().finite().positive().max(7 * 24 * 60),
  onComplete: advanceCompletionSchema.default('pause'),
}).strict()

export const runCopyInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
}).strict()

export const maximumPaceAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().min(1).max(2_000).optional(),
}).strict()

export const accelerationStateSchema = z.object({
  kind: z.enum(['continuous', 'timed']),
  status: z.enum(['running', 'paused', 'stopped', 'completed', 'failed']),
  startedSimulationTime: isoTimestampSchema,
  targetSimulationTime: isoTimestampSchema.optional(),
  currentSimulationTime: isoTimestampSchema,
  onComplete: advanceCompletionSchema,
  startedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  activeWallMs: z.number().finite().nonnegative(),
  simulatedMs: z.number().finite().nonnegative(),
  measuredSpeed: z.number().finite().nonnegative(),
  error: z.string().min(1).max(2_000).optional(),
}).strict()

export const runExecutionStateSchema = z.object({
  playback: runPlaybackSchema,
  pace: runPaceSchema,
  currentSimulationTime: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  maximumPace: maximumPaceAvailabilitySchema,
  acceleration: accelerationStateSchema.nullable(),
}).strict()

export type RunPlayback = z.infer<typeof runPlaybackSchema>
export type RunPace = z.infer<typeof runPaceSchema>
export type AdvanceCompletion = z.infer<typeof advanceCompletionSchema>
export type ExecutionSetInput = z.infer<typeof executionSetInputSchema>
export type AccelerationState = z.infer<typeof accelerationStateSchema>
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
export const maximumPaceStepMs = 1_000
export const maximumPaceProgressWallIntervalMs = 100
export const executionCheckpointWallIntervalMs = 2_000
