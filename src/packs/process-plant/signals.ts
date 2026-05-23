import { z } from 'zod'
import { idSchema } from '../../core/model/index.ts'
import type {
  CompiledPlantGraph,
  ProcessSignalBinding,
  ProcessSignalTagId,
  VariablePath,
} from './graph/index.ts'
import { processSignalTagIdSchema, variablePathSchema } from './graph/index.ts'

export const processPlantSignalReferenceSchema = z.object({
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
}).strict().superRefine((reference, ctx) => {
  const referenceCount = Number(reference.path !== undefined) + Number(reference.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process signal reference must define exactly one of path or tagId',
    })
  }
})
export type ProcessPlantSignalReference = z.infer<typeof processPlantSignalReferenceSchema>

export const processPlantSystemSignalReferenceSchema = z.object({
  systemId: idSchema,
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
}).strict().superRefine((reference, ctx) => {
  const referenceCount = Number(reference.path !== undefined) + Number(reference.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process system signal reference must define exactly one of path or tagId',
    })
  }
})
export type ProcessPlantSystemSignalReference = z.infer<typeof processPlantSystemSignalReferenceSchema>

export const resolveProcessPlantSignalBinding = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): ProcessSignalBinding => {
  if (reference.path !== undefined) {
    const binding = graph.signalBindingByPath.get(reference.path)
    if (!binding) throw new Error(`unknown process plant signal path: ${reference.path}`)
    return binding
  }
  if (reference.tagId !== undefined) {
    const binding = graph.signalBindingByTagId.get(reference.tagId)
    if (!binding) throw new Error(`unknown process plant signal tagId: ${reference.tagId}`)
    return binding
  }
  throw new Error('process signal reference must define path or tagId')
}

export const resolveProcessPlantSignalPath = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): VariablePath => resolveProcessPlantSignalBinding(graph, reference).path

export const processPlantSignalView = (binding: ProcessSignalBinding): Record<string, unknown> => ({
  path: binding.path,
  ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
  ...(binding.equipmentId === undefined ? {} : { equipmentId: binding.equipmentId }),
  ...(binding.description === undefined ? {} : { description: binding.description }),
  ...(binding.externalRefs === undefined ? {} : { externalRefs: binding.externalRefs }),
  ...(binding.capabilities === undefined ? {} : { capabilities: binding.capabilities }),
  ...(binding.limits === undefined ? {} : { limits: binding.limits }),
  label: binding.label,
  kind: binding.kind,
  domain: binding.domain,
  quantity: binding.quantity,
  unit: binding.unit,
  writable: binding.writable,
  published: binding.published,
  owner: binding.owner,
})

export const tagIdForLookup = (value: string): ProcessSignalTagId => processSignalTagIdSchema.parse(value)
