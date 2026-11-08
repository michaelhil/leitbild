import { z } from 'zod'
import { planningOwnerBasisInputSchema, planningOwnerBasisSchema, planningSourceQualificationResultSchema } from '@leitbild/contracts'
import { defineSimulationQueryCapability } from './capabilities.ts'

/** World-private projection protocol; domain facts remain implemented by their Pack. */
export const planningProjectionInputSchema = planningOwnerBasisInputSchema.extend({ purpose: z.enum(['capture', 'qualify']) }).strict()
export const planningProjectionOutputSchema = z.union([planningOwnerBasisSchema, planningSourceQualificationResultSchema])
export const planningProjectionCapability = (id: string) => defineSimulationQueryCapability({
  id,
  title: 'Read shared planning source',
  description: 'World-owned capture or permission-only qualification of a bounded owner planning projection.',
  readScope: 'collection',
  audience: 'system',
  input: planningProjectionInputSchema,
  output: planningProjectionOutputSchema,
})
