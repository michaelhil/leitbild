import { z } from 'zod'

const id = z.string().min(1).max(200)
const modelDigest = z.string().regex(/^[a-f0-9]{64}$/)
export const physicalAnchorSchema = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-85).max(85)])
export const physicalRelatedMemberRequirementSchema = z.object({
  role: id, packId: id, modelRef: id, modelDigest, anchor: physicalAnchorSchema,
}).strict()
export const physicalDesignRequirementsSchema = z.object({
  ownerRole: id, ownerPackId: id,
  /** Present only for an authored site tied to an owner graph's geographic subject. */
  placement: z.object({ anchor: physicalAnchorSchema, bearing: z.number().finite().min(-360).max(360), subjectId: id }).strict().optional(),
  relatedMembers: z.array(physicalRelatedMemberRequirementSchema).max(64),
}).strict().superRefine((value, context) => {
  const roles = [value.ownerRole, ...value.relatedMembers.map(member => member.role)]
  if (new Set(roles).size !== roles.length) context.addIssue({ code: 'custom', message: 'Design member roles must be unique' })
})
export const physicalResolvedMemberSchema = physicalRelatedMemberRequirementSchema.extend({ objectId: id }).strict()
export type PhysicalDesignRequirements = z.infer<typeof physicalDesignRequirementsSchema>
