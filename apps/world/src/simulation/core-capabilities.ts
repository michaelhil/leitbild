import {
  commandResultSchema,
  deleteObjectCommandKind,
  deleteObjectPayloadSchema,
  procedureRunStartCommandKind,
  procedureStepUpdateCommandKind,
  procedureRunCloseCommandKind,
  procedureRunResetCommandKind,
  procedureRunClosePayloadSchema,
  procedureRunResetPayloadSchema,
  procedureRunStartPayloadSchema,
  procedureStepUpdatePayloadSchema,
  type ObjectId,
} from '../core/model/index.ts'
import type { z } from 'zod'
import type { SimulationCapability } from './protocol.ts'
import { defineSimulationCapability } from './capabilities.ts'

const command = <T>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodType<T>
  readonly targets: (input: T) => ReadonlyArray<ObjectId>
  readonly risk?: 'write' | 'destructive'
}): SimulationCapability => defineSimulationCapability({
  id: config.id,
  kind: 'command',
  title: config.title,
  description: config.description,
  risk: config.risk ?? 'write',
  idempotent: false,
  input: config.input,
  output: commandResultSchema,
  buildCommand: raw => {
    const input = config.input.parse(raw)
    return { targetObjectIds: config.targets(input), payload: input }
  },
})

export const worldCoreCapabilities: ReadonlyArray<SimulationCapability> = [
  command({
    id: deleteObjectCommandKind,
    title: 'Delete operational object',
    description: 'Deletes one current operational object from this Simulation Run.',
    input: deleteObjectPayloadSchema,
    targets: input => [input.objectId],
    risk: 'destructive',
  }),
  command({
    id: procedureRunStartCommandKind,
    title: 'Start procedure run',
    description: 'Starts a procedure for an explicit operational scope.',
    input: procedureRunStartPayloadSchema,
    targets: input => input.scope.targetObjectId ? [input.scope.targetObjectId] : [],
  }),
  command({
    id: procedureStepUpdateCommandKind,
    title: 'Update procedure step',
    description: 'Records an assessment, note, favorite, or current-step change in an active procedure run.',
    input: procedureStepUpdatePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunCloseCommandKind,
    title: 'Close procedure run',
    description: 'Completes or abandons an active procedure run.',
    input: procedureRunClosePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunResetCommandKind,
    title: 'Reset procedure run',
    description: 'Clears current procedure state for an explicit operational scope.',
    input: procedureRunResetPayloadSchema,
    targets: input => input.scope.targetObjectId ? [input.scope.targetObjectId] : [],
  }),
]
