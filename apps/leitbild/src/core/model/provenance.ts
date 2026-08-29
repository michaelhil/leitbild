import { z } from 'zod'
import { adapterIdSchema, type AdapterId, type CommandId } from './ids.ts'
import { commandIdSchema } from './ids.ts'

export const dataSourceSchema = z.enum(['simulator', 'operator', 'system', 'ai', 'import'])
export type DataSource = z.infer<typeof dataSourceSchema>

export interface Provenance {
  readonly source: DataSource
  readonly adapterId?: AdapterId
  readonly externalId?: string
  readonly causedByCommandId?: CommandId
}

export const provenanceSchema = z.object({
  source: dataSourceSchema,
  adapterId: adapterIdSchema.optional(),
  externalId: z.string().min(1).optional(),
  causedByCommandId: commandIdSchema.optional(),
})
