import { z } from 'zod'
import { commandEnvelopeSchema, commandResultSchema, type CommandEnvelope, type CommandResult } from './commands.ts'
import { eventIdSchema, objectIdSchema, sessionIdSchema, type EventId, type ObjectId, type SessionId } from './ids.ts'
import { operationalObjectSchema, type OperationalObject } from './object.ts'
import { provenanceSchema, type Provenance } from './provenance.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'
import { telemetryStateSchema, type TelemetryState } from './telemetry.ts'

export interface EventEnvelopeBase {
  readonly id: EventId
  readonly sessionId: SessionId
  readonly seq: number
  readonly at: IsoTimestamp
  readonly provenance: Provenance
}

export type DomainEvent =
  | (EventEnvelopeBase & {
      readonly type: 'object.upserted'
      readonly object: OperationalObject
    })
  | (EventEnvelopeBase & {
      readonly type: 'object.deleted'
      readonly objectId: ObjectId
    })
  | (EventEnvelopeBase & {
      readonly type: 'telemetry.sampled'
      readonly objectId: ObjectId
      readonly telemetry: TelemetryState
    })
  | (EventEnvelopeBase & {
      readonly type: 'command.issued'
      readonly command: CommandEnvelope
    })
  | (EventEnvelopeBase & {
      readonly type: 'command.result'
      readonly result: CommandResult
    })

const eventBaseSchema = z.object({
  id: eventIdSchema,
  sessionId: sessionIdSchema,
  seq: z.number().int().nonnegative(),
  at: isoTimestampSchema,
  provenance: provenanceSchema,
})

export const domainEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({
    type: z.literal('object.upserted'),
    object: operationalObjectSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('object.deleted'),
    objectId: objectIdSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('telemetry.sampled'),
    objectId: objectIdSchema,
    telemetry: telemetryStateSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('command.issued'),
    command: commandEnvelopeSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('command.result'),
    result: commandResultSchema,
  }),
])
