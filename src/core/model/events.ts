import { z } from 'zod'
import { commandEnvelopeSchema, commandResultSchema, type CommandEnvelope, type CommandResult } from './commands.ts'
import { eventIdSchema, objectIdSchema, controlInstanceIdSchema, type EventId, type ObjectId, type ControlInstanceId } from './ids.ts'
import { operationalObjectSchema, type OperationalObject } from './object.ts'
import { provenanceSchema, type Provenance } from './provenance.ts'
import { isoTimestampSchema, simulationClockStateSchema, type IsoTimestamp, type SimulationClockState } from './time.ts'
import { telemetryStateSchema, type TelemetryState } from './telemetry.ts'
import { interactionSignalSchema, operationalNotificationSchema, type InteractionSignal, type OperationalNotification } from './interactions.ts'
import { scenarioGuidanceSchema, type ScenarioGuidance } from './scenario.ts'

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
  | (EventEnvelopeBase & {
      readonly type: 'clock.updated'
      readonly clock: SimulationClockState
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.step.started'
      readonly stepId: string
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.guidance.shown'
      readonly guidance: ScenarioGuidance
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.guidance.hidden'
      readonly guidanceId?: string
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.objects.highlighted'
      readonly objectIds: ReadonlyArray<ObjectId>
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.highlights.cleared'
      readonly objectIds?: ReadonlyArray<ObjectId>
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
  eventBaseSchema.extend({
    type: z.literal('clock.updated'),
    clock: simulationClockStateSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.step.started'),
    stepId: z.string().min(1),
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.guidance.shown'),
    guidance: scenarioGuidanceSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.guidance.hidden'),
    guidanceId: z.string().min(1).optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.objects.highlighted'),
    objectIds: z.array(objectIdSchema),
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.highlights.cleared'),
    objectIds: z.array(objectIdSchema).optional(),
  }),
])
