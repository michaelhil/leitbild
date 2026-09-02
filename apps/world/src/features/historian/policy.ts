import { z } from 'zod'

export interface HistorianLimits {
  readonly maxSamples: number
  readonly maxAgeMs: number
  readonly maxBytes: number
  readonly minFreeBytes: number
}

export const defaultHistorianLimits: HistorianLimits = {
  maxSamples: 250_000, maxAgeMs: 7 * 86_400_000, maxBytes: 256 * 1024 * 1024, minFreeBytes: 1024 * 1024 * 1024,
}

export const resolveHistorianLimits = (overrides: Partial<HistorianLimits> = {}): HistorianLimits => {
  const limits = { ...defaultHistorianLimits, ...overrides }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Historian limits must be nonnegative safe integers')
  if (limits.maxSamples < 1 || limits.maxBytes < 64 * 1024 || limits.maxAgeMs < 1) throw new Error('Historian retention budget is too small')
  return limits
}

export const runHistorianStatusSchema = z.object({
  seriesCount: z.number().int().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  firstObservedAt: z.string().nullable(), lastObservedAt: z.string().nullable(),
  captureState: z.enum(['recording', 'limited', 'unavailable']), lastError: z.string().nullable(),
  discardedSinceOpen: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative().nullable(),
  databaseBytes: z.number().int().nonnegative().nullable(),
  walBytes: z.number().int().nonnegative().nullable(),
  limits: z.object({ maxSamples: z.number(), maxAgeMs: z.number(), maxBytes: z.number(), minFreeBytes: z.number() }).strict(),
}).strict()
export type RunHistorianStatus = z.infer<typeof runHistorianStatusSchema>
