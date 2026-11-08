import { z } from 'zod'
import { engineeringQuantitySchema, engineeringQualificationResultSchema } from '@leitbild/contracts'
import { defineSimulationQueryCapability } from './capabilities.ts'
import { objectIdSchema } from '../core/model/ids.ts'

export const engineeringOwnerInputSchema = z.object({ subjectId: z.string().min(1), purpose: z.enum(['capture', 'qualify']) }).strict()
export const engineeringOwnerBasisSchema = z.object({
  modelElapsedMs: z.number().finite().nonnegative(), modelDigest: z.string().min(1),
  domainEnd: z.string().nullable(), quantities: z.array(engineeringQuantitySchema).min(1).max(32),
}).strict()
export const engineeringOwnerOutputSchema = z.union([engineeringOwnerBasisSchema, engineeringQualificationResultSchema])
export const engineeringProjectionCapability = (id: string) => defineSimulationQueryCapability({
  id, title: 'Read engineering research basis',
  description: 'World-internal bounded shared research projection. The Pack owns quantity meaning and profile admission.',
  readScope: 'object', audience: 'system',
  input: engineeringOwnerInputSchema, output: engineeringOwnerOutputSchema,
  inspectObjectIds: input => [objectIdSchema.parse(engineeringOwnerInputSchema.parse(input).subjectId)],
})
