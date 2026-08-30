import { z } from 'zod'
import { isoTimestampSchema } from './ids.ts'
import { workspaceDefinitionRevisionReferenceSchema } from './definitions.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'

const inspectionSectionIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)

export const inspectionTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('definition'),
    definition: workspaceDefinitionRevisionReferenceSchema,
  }).strict(),
  z.object({
    kind: z.literal('resource'),
    resource: workspaceResourceReferenceSchema,
  }).strict(),
])
export type InspectionTarget = z.infer<typeof inspectionTargetSchema>

export const inspectionSectionSchema = z.object({
  id: inspectionSectionIdSchema,
  title: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2048).optional(),
  data: z.json(),
}).strict()
export type InspectionSection = z.infer<typeof inspectionSectionSchema>

export const inspectionViewSchema = z.object({
  target: inspectionTargetSchema,
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(4096).optional(),
  observedAt: isoTimestampSchema,
  sections: z.array(inspectionSectionSchema).min(1).max(16),
}).strict().superRefine((view, ctx) => {
  const seen = new Set<string>()
  view.sections.forEach((section, index) => {
    if (seen.has(section.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections', index, 'id'],
        message: `duplicate Inspection Section: ${section.id}`,
      })
    }
    seen.add(section.id)
  })
})
export type InspectionView = z.infer<typeof inspectionViewSchema>
