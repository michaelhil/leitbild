import { z } from 'zod'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export const alertSeveritySchema = z.enum(['info', 'warning', 'critical'])
export type AlertSeverity = z.infer<typeof alertSeveritySchema>

export interface AlertState {
  readonly id: string
  readonly kind: string
  readonly severity: AlertSeverity
  readonly message: string
  readonly raisedAt: IsoTimestamp
  readonly acknowledged: boolean
}

export const alertStateSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  severity: alertSeveritySchema,
  message: z.string().min(1),
  raisedAt: isoTimestampSchema,
  acknowledged: z.boolean(),
})
