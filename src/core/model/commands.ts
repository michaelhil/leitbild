import { z } from 'zod'
import { actorIdSchema, commandIdSchema, objectIdSchema, sessionIdSchema, type ActorId, type CommandId, type ObjectId, type SessionId } from './ids.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export interface CommandEnvelope {
  readonly id: CommandId
  readonly sessionId: SessionId
  readonly actorId: ActorId
  readonly kind: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly payload: unknown
  readonly issuedAt: IsoTimestamp
  readonly expectedRevision?: number
}

export type CommandResult =
  | {
      readonly ok: true
      readonly commandId: CommandId
      readonly acceptedAt: IsoTimestamp
    }
  | {
      readonly ok: false
      readonly commandId: CommandId
      readonly rejectedAt: IsoTimestamp
      readonly reason: string
    }

export const commandEnvelopeSchema = z.object({
  id: commandIdSchema,
  sessionId: sessionIdSchema,
  actorId: actorIdSchema,
  kind: z.string().min(1),
  targetObjectIds: z.array(objectIdSchema),
  payload: z.custom<unknown>(value => value !== undefined, 'payload is required'),
  issuedAt: isoTimestampSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
})

export const commandResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    commandId: commandIdSchema,
    acceptedAt: isoTimestampSchema,
  }),
  z.object({
    ok: z.literal(false),
    commandId: commandIdSchema,
    rejectedAt: isoTimestampSchema,
    reason: z.string().min(1),
  }),
])
