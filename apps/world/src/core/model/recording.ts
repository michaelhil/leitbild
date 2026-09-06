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

export const recordingSeriesQuerySchema = z.object({
  mode: z.enum(['summary', 'raw']).default('summary').describe('Summary returns retained-window statistics without raw rows. Raw adds a sequence-paginated sample page.'),
  runtimeId: z.string().trim().min(1).max(128).optional(),
  seriesId: z.string().trim().min(1).max(128).optional(),
  subjectId: z.string().trim().min(1).max(128).optional(),
  signalId: z.string().trim().min(1).max(512).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().positive().max(10_000).optional().describe('Raw page size only; does not change whole-window summaries.'),
  timeAxis: z.enum(['observed', 'simulation']).optional().describe('Time-window axis; observed (capture wall time) is the default. Use simulation for simulated-time questions.'),
  beforeSequence: z.number().int().positive().optional().describe('Exclusive raw-page cursor; does not filter the window summary. Not valid in summary mode.'),
}).strict().superRefine((query, context) => {
  if (query.mode === 'summary' && (!query.runtimeId || !query.seriesId)) context.addIssue({ code: 'custom', path: ['seriesId'], message: 'Summary requires one exact runtimeId and seriesId from the series catalog' })
  if (query.mode === 'summary' && query.beforeSequence !== undefined) context.addIssue({ code: 'custom', path: ['beforeSequence'], message: 'beforeSequence is a raw-page cursor; use mode raw' })
  if (query.from !== undefined && query.to !== undefined && Date.parse(query.from) > Date.parse(query.to)) context.addIssue({ code: 'custom', path: ['to'], message: 'to must not precede from' })
})
export type RecordingSeriesQuery = z.input<typeof recordingSeriesQuerySchema>

export interface RecordedSample extends RecordingSample {
  readonly runtimeId: string
  readonly sequence: number
}

export interface RecordingWindowSummary {
  readonly sampleCount: number
  readonly seriesCount: number
  readonly qualityCounts: Readonly<Record<'good' | 'uncertain' | 'bad', number>>
  readonly firstSample: RecordedSample | null
  readonly lastSample: RecordedSample | null
  readonly distinctValueCount: number
  readonly numericMinimum: number | null
  readonly numericMaximum: number | null
  readonly numericAverage: number | null
}

interface RecordingWindow {
  readonly windowSummary: RecordingWindowSummary
  readonly retainedFromSequence: number | null
  readonly retainedFromObservedAt: string | null
  readonly retainedToObservedAt: string | null
  readonly retainedFromSimulationTime: string | null
  readonly retainedToSimulationTime: string | null
  readonly retentionGap: boolean
}

export type RecordingPage = RecordingWindow & (
  | { readonly mode: 'summary' }
  | { readonly mode: 'raw'; readonly samples: ReadonlyArray<RecordedSample>; readonly hasMore: boolean; readonly nextBeforeSequence: number | null }
)

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
