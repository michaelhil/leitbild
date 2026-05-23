import { z } from 'zod'
import { processSignalTagIdSchema, processVariableValueSchema, variablePathSchema } from './graph/index.ts'

export const processPlantControlWriteCommandKind = 'process-plant.control.write'

export const processPlantControlWritePayloadSchema = z.object({
  systemId: z.string().min(1),
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
  value: processVariableValueSchema,
}).strict().superRefine((payload, ctx) => {
  const referenceCount = Number(payload.path !== undefined) + Number(payload.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process plant control write must define exactly one of path or tagId',
    })
  }
})

export type ProcessPlantControlWritePayload = z.infer<typeof processPlantControlWritePayloadSchema>
