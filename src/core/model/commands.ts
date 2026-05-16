import { z } from 'zod'
import { actorIdSchema, clientIdSchema, commandIdSchema, objectIdSchema, controlInstanceIdSchema, type ActorId, type ClientId, type CommandId, type ObjectId, type ControlInstanceId } from './ids.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export interface CommandEnvelope {
  readonly id: CommandId
  readonly controlInstanceId: ControlInstanceId
  readonly actorId: ActorId
  readonly clientId?: ClientId
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
  controlInstanceId: controlInstanceIdSchema,
  actorId: actorIdSchema,
  clientId: clientIdSchema.optional(),
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
