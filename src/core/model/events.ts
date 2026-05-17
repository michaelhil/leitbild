import { z } from 'zod'
import { commandEnvelopeSchema, commandResultSchema, type CommandEnvelope, type CommandResult } from './commands.ts'
import { eventIdSchema, objectIdSchema, controlInstanceIdSchema, type EventId, type ObjectId, type ControlInstanceId } from './ids.ts'
import { operationalObjectSchema, type OperationalObject } from './object.ts'
import { provenanceSchema, type Provenance } from './provenance.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'
import { telemetryStateSchema, type TelemetryState } from './telemetry.ts'
import { interactionSignalSchema, operationalNotificationSchema, type InteractionSignal, type OperationalNotification } from './interactions.ts'

export interface EventEnvelopeBase {
  readonly id: EventId
  readonly controlInstanceId: ControlInstanceId
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
  | (EventEnvelopeBase & {
      readonly type: 'interaction.signal.received'
      readonly signal: InteractionSignal
    })
  | (EventEnvelopeBase & {
      readonly type: 'notification.emitted'
      readonly notification: OperationalNotification
    })

const eventBaseSchema = z.object({
  id: eventIdSchema,
  controlInstanceId: controlInstanceIdSchema,
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
  eventBaseSchema.extend({
    type: z.literal('interaction.signal.received'),
    signal: interactionSignalSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('notification.emitted'),
    notification: operationalNotificationSchema,
  }),
])
