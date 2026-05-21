import { z } from 'zod'
import { processVariableValueSchema, variablePathSchema } from './graph/index.ts'

export const processPlantControlWriteCommandKind = 'process-plant.control.write'

export const processPlantControlWritePayloadSchema = z.object({
  systemId: z.string().min(1),
  path: variablePathSchema,
  value: processVariableValueSchema,
})

export type ProcessPlantControlWritePayload = z.infer<typeof processPlantControlWritePayloadSchema>
