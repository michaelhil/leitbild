import { z } from 'zod'
import { geoJsonGeometrySchema, type GeoJsonGeometry } from './geo.ts'
import {
  actorIdSchema,
  clientIdSchema,
  controlInstanceIdSchema,
  idSchema,
  notificationIdSchema,
  objectIdSchema,
  signalIdSchema,
  type ActorId,
  type ClientId,
  type ControlInstanceId,
  type NotificationId,
  type ObjectId,
  type SignalId,
} from './ids.ts'
import { operationalObjectSchema, type OperationalObject } from './object.ts'
import { provenanceSchema, type Provenance } from './provenance.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export type InteractionEndpoint =
  | {
      readonly kind: 'object'
      readonly id: ObjectId
      readonly providerId?: string
    }
  | {
      readonly kind: 'simulation'
      readonly id: string
    }
  | {
      readonly kind: 'actor'
      readonly id: ActorId
    }
  | {
      readonly kind: 'client'
      readonly id: ClientId
    }
  | {
      readonly kind: 'area'
      readonly geometry: GeoJsonGeometry
    }
  | {
      readonly kind: 'role'
      readonly id: string
    }
  | {
      readonly kind: 'broadcast'
    }

export interface InteractionSignal {
  readonly id: SignalId
  readonly controlInstanceId: ControlInstanceId
  readonly at: IsoTimestamp
  readonly source: InteractionEndpoint
  readonly targets: ReadonlyArray<InteractionEndpoint>
  readonly type: string
  readonly payload: unknown
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
  readonly correlationId?: string
  readonly causationId?: string
  readonly ttlMs?: number
}

export interface OperationalNotification {
  readonly id: NotificationId
  readonly controlInstanceId: ControlInstanceId
  readonly at: IsoTimestamp
  readonly title: string
  readonly message: string
  readonly severity: 'info' | 'notice' | 'warning' | 'critical'
  readonly source: InteractionEndpoint
  readonly targets: ReadonlyArray<InteractionEndpoint>
  readonly signalId?: SignalId
}

export type InteractionEffect =
  | {
      readonly type: 'object.upsert'
      readonly object: OperationalObject
    }
  | {
      readonly type: 'object.delete'
      readonly objectId: ObjectId
    }
  | {
      readonly type: 'notification.emit'
      readonly notification: OperationalNotification
    }

export interface InteractionSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
}

export interface InteractionHandlerInput {
  readonly signal: InteractionSignal
  readonly snapshot: InteractionSnapshot
  readonly provenance: Provenance
}

export interface InteractionHandler {
  readonly id: string
  readonly priority: number
  readonly accepts: (signal: InteractionSignal) => boolean
  readonly handle: (input: InteractionHandlerInput) => Promise<ReadonlyArray<InteractionEffect>>
}

export const interactionEndpointSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('object'),
    id: objectIdSchema,
    providerId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('simulation'),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('actor'),
    id: actorIdSchema,
  }),
  z.object({
    kind: z.literal('client'),
    id: clientIdSchema,
  }),
  z.object({
    kind: z.literal('area'),
    geometry: geoJsonGeometrySchema,
  }),
  z.object({
    kind: z.literal('role'),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('broadcast'),
  }),
])

export const interactionSignalSchema = z.object({
  id: signalIdSchema,
  controlInstanceId: controlInstanceIdSchema,
  at: isoTimestampSchema,
  source: interactionEndpointSchema,
  targets: z.array(interactionEndpointSchema),
  type: idSchema,
  payload: z.unknown(),
  severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
  correlationId: idSchema.optional(),
  causationId: idSchema.optional(),
  ttlMs: z.number().finite().positive().optional(),
})

export const operationalNotificationSchema = z.object({
  id: notificationIdSchema,
  controlInstanceId: controlInstanceIdSchema,
  at: isoTimestampSchema,
  title: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(['info', 'notice', 'warning', 'critical']),
  source: interactionEndpointSchema,
  targets: z.array(interactionEndpointSchema),
  signalId: signalIdSchema.optional(),
})

export const interactionEffectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('object.upsert'),
    object: operationalObjectSchema,
  }),
  z.object({
    type: z.literal('object.delete'),
    objectId: objectIdSchema,
  }),
  z.object({
    type: z.literal('notification.emit'),
    notification: operationalNotificationSchema,
  }),
])
