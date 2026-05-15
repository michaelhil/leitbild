import { z } from 'zod'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export const signalSeveritySchema = z.enum(['normal', 'warning', 'critical'])
export type SignalSeverity = z.infer<typeof signalSeveritySchema>

export interface TimeSeriesSample {
  readonly at: IsoTimestamp
  readonly value: number
}

export interface TimeSeriesSignal {
  readonly signalId: string
  readonly label: string
  readonly unit: string
  readonly latest: number
  readonly samples: ReadonlyArray<TimeSeriesSample>
  readonly severity: SignalSeverity
}

export interface TelemetryState {
  readonly signals: Readonly<Record<string, TimeSeriesSignal>>
}

export const timeSeriesSampleSchema = z.object({
  at: isoTimestampSchema,
  value: z.number().finite(),
})

export const timeSeriesSignalSchema = z.object({
  signalId: z.string().min(1),
  label: z.string().min(1),
  unit: z.string().min(1),
  latest: z.number().finite(),
  samples: z.array(timeSeriesSampleSchema),
  severity: signalSeveritySchema,
})

export const telemetryStateSchema = z.object({
  signals: z.record(timeSeriesSignalSchema),
})
