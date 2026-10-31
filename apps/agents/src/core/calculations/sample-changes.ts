import { z } from 'zod'

// Explicit milliseconds avoid Date.parse silently discarding finer precision.
// Zod also rejects calendar-invalid dates before arithmetic touches them.
const timestampSchema = z.iso.datetime({ offset: true, precision: 3 })
const labelSchema = z.string().min(1).refine(value => value.trim() === value && value.length > 0, 'Use a nonempty label without surrounding whitespace')
const seriesSchema = z.object({
  key: labelSchema,
  unit: labelSchema.optional().describe('Caller-provided label, echoed unchanged; no unit conversion or inference.'),
  values: z.array(z.number().finite()).min(2),
}).strict()

export const sampleChangesInputSchema = z.object({
  timestamps: z.array(timestampSchema).min(2)
    .describe('Shared actual sample times, in supplied order, with exactly three fractional digits and an explicit UTC offset or Z.'),
  series: z.array(seriesSchema).min(1),
}).strict().superRefine((input, ctx) => {
  const instants = input.timestamps.map(value => Date.parse(value))
  for (let index = 0; index < instants.length; index += 1) {
    if (!Number.isSafeInteger(instants[index])) {
      ctx.addIssue({ code: 'custom', path: ['timestamps', index], message: 'Timestamp must represent an exact finite millisecond instant' })
    }
    if (index > 0 && !(instants[index]! > instants[index - 1]!)) {
      ctx.addIssue({ code: 'custom', path: ['timestamps', index], message: 'Actual sample instants must be strictly increasing; samples are not sorted or repaired' })
    }
  }
  const keys = new Set<string>()
  for (const [index, series] of input.series.entries()) {
    if (keys.has(series.key)) ctx.addIssue({ code: 'custom', path: ['series', index, 'key'], message: 'Series keys must be unique' })
    keys.add(series.key)
    if (series.values.length !== input.timestamps.length) {
      ctx.addIssue({ code: 'custom', path: ['series', index, 'values'], message: 'Each series must supply exactly one value per timestamp' })
    }
  }
})

export const sampleChangesResultSchema = z.object({
  kind: z.literal('sample-changes'),
  inputsVerified: z.literal(false),
  arithmetic: z.literal('IEEE-754 binary64'),
  timestamps: z.array(timestampSchema).min(2),
  intervals: z.array(z.object({
    from: timestampSchema,
    to: timestampSchema,
    elapsedMs: z.number().int().positive(),
    elapsedSeconds: z.number().positive().finite(),
  }).strict()).min(1),
  series: z.array(seriesSchema.extend({
    changes: z.array(z.object({ change: z.number().finite(), ratePerSecond: z.number().finite() }).strict()).min(1),
  }).strict()).min(1),
}).strict()

/** Arithmetic on supplied samples, never an acquisition or physical proof. */
export const calculateSampleChanges = (raw: unknown): z.infer<typeof sampleChangesResultSchema> => {
  const input = sampleChangesInputSchema.parse(raw)
  const intervals = input.timestamps.slice(1).map((to, index) => {
    const from = input.timestamps[index]!
    const elapsedMs = Date.parse(to) - Date.parse(from)
    return { from, to, elapsedMs, elapsedSeconds: elapsedMs / 1_000 }
  })
  const series = input.series.map((series, seriesIndex) => ({
    ...series,
    changes: intervals.map((interval, index) => {
      const change = series.values[index + 1]! - series.values[index]!
      const ratePerSecond = change / interval.elapsedSeconds
      if (!Number.isFinite(change) || !Number.isFinite(ratePerSecond)) {
        throw new z.ZodError([{ code: 'custom', path: ['series', seriesIndex, 'values', index + 1], message: 'Sample change or rate is nonfinite in IEEE-754 binary64 arithmetic' }])
      }
      return { change, ratePerSecond }
    }),
  }))
  return sampleChangesResultSchema.parse({ kind: 'sample-changes', inputsVerified: false, arithmetic: 'IEEE-754 binary64', ...input, intervals, series })
}
