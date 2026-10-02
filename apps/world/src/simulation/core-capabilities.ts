import type { z } from 'zod'
import {
  commandResultSchema,
  deleteObjectCommandKind,
  deleteObjectPayloadSchema,
  objectIdSchema,
  procedureRunCloseCommandKind,
  procedureRunClosePayloadSchema,
  procedureRunResetCommandKind,
  procedureRunResetPayloadSchema,
  procedureRunStartCommandKind,
  procedureRunStartPayloadSchema,
  procedureRunTransitionCommandKind,
  procedureRunTransitionPayloadSchema,
  procedureStepUpdateCommandKind,
  procedureStepUpdatePayloadSchema,
  type ObjectId,
} from '../core/model/index.ts'
import { defineSimulationCapability } from './capabilities.ts'
import type { SimulationCapability } from './protocol.ts'

const command = <T>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodType<T>
  readonly targets: (input: T) => ReadonlyArray<ObjectId>
  readonly risk?: 'write' | 'destructive'
  readonly schedulable?: boolean
}): SimulationCapability => defineSimulationCapability({
  id: config.id,
  kind: 'command',
  title: config.title,
  description: config.description,
  risk: config.risk ?? 'write',
  idempotent: false,
  ...(config.schedulable === undefined ? {} : { schedulable: config.schedulable }),
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
    schedulable: true,
  }),
  command({
    id: procedureRunStartCommandKind,
    title: 'Start procedure run',
    description: 'Starts a pinned procedure for an explicit operational scope, or resumes a transferred procedure at its preserved step. Completed or abandoned procedures require an explicit reset.',
    input: procedureRunStartPayloadSchema,
    targets: input => [objectIdSchema.parse(input.scope.plantId)],
  }),
  command({
    id: procedureStepUpdateCommandKind,
    title: 'Update procedure step',
    description: 'Records an assessment, note, favorite, or current-step change in an active procedure run.',
    input: procedureStepUpdatePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunTransitionCommandKind,
    title: 'Follow procedure branch',
    description: 'Atomically follows a declared local-step, procedure, retry, END, or ABORT branch from the pinned document. Records the chosen branch and available condition evidence. A procedure transfer preserves source placekeeping; an explicitly parallel branch keeps it active. Only authored outcome labels change step assessment. Read the pinned document to select stepId and branchIndex.',
    input: procedureRunTransitionPayloadSchema,
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
    targets: input => [objectIdSchema.parse(input.scope.plantId)],
  }),
]
