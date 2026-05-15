import { z } from 'zod'
import { commandEnvelopeSchema, domainIdSchema, sessionIdSchema } from '../core/model/index.ts'

export const simulationProtocolVersion = 1

export const leitbildToSimulationMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.literal(simulationProtocolVersion),
    sessionId: sessionIdSchema,
    domain: domainIdSchema,
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

export type LeitbildToSimulationMessage = z.infer<typeof leitbildToSimulationMessageSchema>

export const simulationToLeitbildMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello.accepted'),
    protocolVersion: z.literal(simulationProtocolVersion),
    simulatorId: z.string().min(1),
  }),
  z.object({
    type: z.literal('heartbeat'),
    simTime: z.string().datetime(),
    wallTime: z.string().datetime(),
  }),
])

export type SimulationToLeitbildMessage = z.infer<typeof simulationToLeitbildMessageSchema>
