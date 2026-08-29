import { z } from 'zod'
import { requestIdSchema } from './ids.ts'

export const platformErrorCodeSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)

export const platformErrorSchema = z.object({
  error: z.object({
    code: platformErrorCodeSchema,
    message: z.string().min(1),
    requestId: requestIdSchema.optional(),
    retryable: z.boolean().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict()
export type PlatformError = z.infer<typeof platformErrorSchema>

export const platformError = (config: {
  readonly code: string
  readonly message: string
  readonly requestId?: z.infer<typeof requestIdSchema>
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>
}): PlatformError => platformErrorSchema.parse({
  error: {
    code: config.code,
    message: config.message,
    ...(config.requestId === undefined ? {} : { requestId: config.requestId }),
    ...(config.retryable === undefined ? {} : { retryable: config.retryable }),
    ...(config.details === undefined ? {} : { details: config.details }),
  },
})
