import { z } from 'zod'
import {
  eventIdSchema,
  isoTimestampSchema,
  moduleIdSchema,
  protocolVersionSchema,
  resourceIdSchema,
  workspaceIdSchema,
} from './ids.ts'

export const resourceReferenceSchema = z.object({
  moduleId: moduleIdSchema,
  kind: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  id: resourceIdSchema,
}).strict()
export type ResourceReference = z.infer<typeof resourceReferenceSchema>

export const platformEventEnvelopeSchema = z.object({
  schemaVersion: protocolVersionSchema,
  id: eventIdSchema,
  workspaceId: workspaceIdSchema,
  resource: resourceReferenceSchema,
  type: z.string().min(1).max(128).regex(/^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/),
  at: isoTimestampSchema,
  sequence: z.number().int().nonnegative().optional(),
  correlationId: z.string().min(1).max(256).optional(),
  causationId: z.string().min(1).max(256).optional(),
  payload: z.unknown(),
}).strict()
export type PlatformEventEnvelope = z.infer<typeof platformEventEnvelopeSchema>
