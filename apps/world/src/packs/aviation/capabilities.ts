import { z } from 'zod'
import { commandResultSchema } from '../../core/model/index.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import { aviationSetSourceCommandKind, aviationSources } from './sim/multi/constants.ts'

export const aviationSourceStatusQueryKind = 'world.aviation.source-status'

export const aviationSourceStatusResultSchema = z.object({
  source: z.enum(aviationSources),
  aircraftInBbox: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  polling: z.boolean(),
  multi: z.object({
    activeSource: z.enum(aviationSources),
    tracked: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict()

export const aviationSourceStatusCapability: SimulationCapability = defineSimulationQueryCapability({
  id: aviationSourceStatusQueryKind,
  title: 'Read aviation source status',
  description: 'Returns the active live-aircraft source, polling health, and current aircraft count.',
  input: z.object({}).strict(),
  output: aviationSourceStatusResultSchema,
})

export const aviationSetSourcePayloadSchema = z.object({ source: z.enum(aviationSources) }).strict()

export const aviationSetSourceCapability: SimulationCapability = defineSimulationCommandCapability({
  id: aviationSetSourceCommandKind,
  title: 'Set aviation source',
  description: 'Switches the active live-aircraft source for a multi-source Aviation runtime.',
  input: aviationSetSourcePayloadSchema,
  output: commandResultSchema,
  idempotent: true,
  schedulable: true,
  buildCommand: input => ({ targetObjectIds: [], payload: aviationSetSourcePayloadSchema.parse(input) }),
})
