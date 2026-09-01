import { z } from 'zod'
import { idSchema } from './ids.ts'
import { isoTimestampSchema } from './time.ts'

export const recordingProfileDescriptorSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  defaultIntervalMs: z.number().int().positive(),
  minimumIntervalMs: z.number().int().positive(),
}).strict().refine(
  profile => profile.defaultIntervalMs >= profile.minimumIntervalMs,
  'recording profile default interval must not be shorter than its minimum interval',
)
export type RecordingProfileDescriptor = z.infer<typeof recordingProfileDescriptorSchema>

export const scenarioRecordingSelectionSchema = z.object({
  packId: idSchema,
  profileId: idSchema,
  intervalMs: z.number().int().positive().optional(),
}).strict()
export type ScenarioRecordingSelection = z.infer<typeof scenarioRecordingSelectionSchema>

export const recordingSeriesDescriptorSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  signalId: z.string().min(1).max(512),
  title: z.string().min(1),
  valueType: z.enum(['number', 'boolean', 'string']),
  quantity: z.string().min(1).optional(),
  unit: z.string().optional(),
}).strict()
export type RecordingSeriesDescriptor = z.infer<typeof recordingSeriesDescriptorSchema>

export const recordingSampleSchema = z.object({
  seriesId: idSchema,
  observedAt: isoTimestampSchema,
  simulationTime: isoTimestampSchema.optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  value: z.union([z.number().finite(), z.boolean(), z.string()]),
  quality: z.enum(['good', 'uncertain', 'bad']).default('good'),
}).strict()
export type RecordingSample = z.infer<typeof recordingSampleSchema>

export const packRuntimeRecordingBatchSchema = z.object({
  descriptors: z.array(recordingSeriesDescriptorSchema).default([]),
  samples: z.array(recordingSampleSchema),
}).strict()
export type PackRuntimeRecordingBatch = z.infer<typeof packRuntimeRecordingBatchSchema>

export interface RecordingSeriesQuery {
  readonly runtimeId?: string
  readonly seriesId?: string
  readonly subjectId?: string
  readonly signalId?: string
  readonly from?: string
  readonly to?: string
  readonly limit?: number
}

export interface RecordedSample extends RecordingSample {
  readonly runtimeId: string
}

const hash32 = (value: string, seed: number): string => {
  let hash = (0x811c9dc5 ^ seed) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const recordingSeriesIdFor = (subjectId: string, signalId: string): string => {
  const key = `${subjectId}\u0000${signalId}`
  return `series:${hash32(key, 0)}${hash32(key, 0x9e3779b9)}${hash32(key, 0x85ebca6b)}`
}
