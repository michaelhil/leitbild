import { z } from 'zod'
import { commandEnvelopeSchema, packIdSchema, controlInstanceIdSchema } from '../core/model/index.ts'

export const runtimeProtocolVersion = 1

export const leitbildToRuntimeMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.literal(runtimeProtocolVersion),
    controlInstanceId: controlInstanceIdSchema,
    packId: packIdSchema,
  }),
  z.object({
    type: z.literal('snapshot.request'),
    requestId: z.string().min(1),
  }),
  z.object({
    type: z.literal('command.issue'),
    command: commandEnvelopeSchema,
  }),
  z.object({
    type: z.literal('clock.set'),
    paused: z.boolean(),
    speed: z.number().finite().positive(),
  }),
])

export type LeitbildToRuntimeMessage = z.infer<typeof leitbildToRuntimeMessageSchema>

export const runtimeToLeitbildMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello.accepted'),
    protocolVersion: z.literal(runtimeProtocolVersion),
    runtimeId: z.string().min(1),
  }),
  z.object({
    type: z.literal('heartbeat'),
    simTime: z.string().datetime(),
    wallTime: z.string().datetime(),
  }),
])

export type RuntimeToLeitbildMessage = z.infer<typeof runtimeToLeitbildMessageSchema>
