import { z } from 'zod'
import { processSignalTagIdSchema, processVariableValueSchema, variablePathSchema } from './graph/index.ts'
import {
  processPlantControlWriteCommandKind,
  processPlantControlRampCommandKind,
  processPlantIcLifecycleCommandKind,
  processPlantActionInvokeCommandKind,
} from './command-kinds.ts'

export {
  processPlantControlWriteCommandKind,
  processPlantControlRampCommandKind,
  processPlantIcLifecycleCommandKind,
  processPlantActionInvokeCommandKind,
}

export const processPlantActionInvokePayloadSchema = z.object({
  plantId: z.string().min(1),
  actionId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
}).strict()
export type ProcessPlantActionInvokePayload = z.infer<typeof processPlantActionInvokePayloadSchema>

export const processPlantControlWritePayloadSchema = z.object({
  plantId: z.string().min(1),
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

export const processPlantControlRampPayloadSchema = z.object({
  plantId: z.string().min(1),
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
  targetValue: z.number().finite(),
  durationSeconds: z.number().finite().positive(),
}).strict().superRefine((payload, ctx) => {
  const referenceCount = Number(payload.path !== undefined) + Number(payload.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process plant control ramp must define exactly one of path or tagId',
    })
  }
})

export type ProcessPlantControlRampPayload = z.infer<typeof processPlantControlRampPayloadSchema>

const processPlantIcCommandLifecycleActionSchema = z.enum([
  'acknowledge',
  'reset',
  'suppress',
  'unsuppress',
  'shelve',
  'unshelve',
])

export const processPlantIcLifecyclePayloadSchema = z.object({
  plantId: z.string().min(1),
  lifecycleId: z.string().min(1),
  action: processPlantIcCommandLifecycleActionSchema,
  reason: z.string().min(1).optional(),
  shelveDurationMs: z.number().finite().positive().optional(),
}).strict()

export type ProcessPlantIcLifecyclePayload = z.infer<typeof processPlantIcLifecyclePayloadSchema>
